use std::cell::RefCell;
use std::{
    cmp::Ordering,
    fmt::{self, Debug},
    ops::Deref,
    rc::Rc,
    vec,
};

use ahash::{AHashMap, AHashSet};
use derivative::Derivative;
use regex::Regex;
use relative_path::RelativePathBuf;
use serde::Serialize;

use logger::{debug, error, info, trace};
use utils::{generate_definition_id, is_html_element};

use crate::module_resolver::{ExportId, ModuleId, ModuleResolver, ModuleType};
use crate::parser::CharacterPosition;
use crate::parser::{
    symbol::{MemberProperty, DEFAULT_EXPORT_NAME},
    Definition, ExportSource, InferredType, Module, ModuleExport, ParserError, PropDefinition, Reference,
    ReferenceWithSource, Symbol, SymbolWithSource, Usage,
};

mod styled_components;
use styled_components::{
    STYLED_COMPONENTS, STYLED_COMPONENTS_MACRO_MODULE_NAME, STYLED_COMPONENTS_MODULE_NAME,
};

#[derive(Serialize, Debug, Eq, PartialEq, Clone)]
pub struct Export {
    pub name: String,
    pub module_id: ModuleId,
    pub reference: ReferenceWithSource,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub inferred_type: Rc<InferredType>,
    pub resolved_type: Rc<InferredType>,
    pub trace_to_declaration: Vec<ReferenceWithSource>,
    pub is_component: bool,
}

impl Export {
    fn new(
        module_id: ModuleId,
        name: String,
        reference: ReferenceWithSource,
        created_at: Option<i64>,
        updated_at: Option<i64>,
        inferred_type: Rc<InferredType>,
        resolved_type: Rc<InferredType>,
        trace_to_declaration: Vec<ReferenceWithSource>,
    ) -> Self {
        Self {
            module_id,
            name,
            reference,
            created_at,
            updated_at,
            inferred_type,
            resolved_type,
            trace_to_declaration,
            is_component: false,
        }
    }

    fn get_hash_key(&self) -> String {
        format!("{}:{}", self.module_id.hash, self.name)
    }

    fn mark_as_component(&mut self) {
        self.is_component = true
    }
}

#[derive(Serialize, PartialEq, Eq, Hash, Debug, Clone)]
pub struct DependencyNode {
    pub source: SymbolWithSource,
    pub id: String,
    pub name: String,
}

impl DependencyNode {
    pub fn is_local(&self) -> bool {
        self.source.is_local()
    }

    pub fn is_external(&self) -> bool {
        self.source.is_external()
    }
}

#[derive(Serialize, Derivative, Debug, Clone)]
#[derivative(PartialEq, Eq, Hash)]
pub struct Dependency {
    pub from: DependencyNode,
    pub to: DependencyNode,
    // TODO: rename this field to data
    #[derivative(PartialEq = "ignore", Hash = "ignore")]
    pub references: Vec<DependencyDatum>,
}

impl Dependency {
    fn new(from: &Component, to: &Component, reference: Vec<DependencyDatum>) -> Self {
        let from = DependencyNode {
            source: from.source.clone(),
            id: from.id.clone(),
            name: from.name.clone(),
        };
        let to = DependencyNode {
            source: to.source.clone(),
            id: to.id.clone(),
            name: to.name.clone(),
        };
        Self {
            from,
            to,
            references: reference,
        }
    }
}

#[derive(Serialize, Debug)]
pub struct Component {
    pub id: String,
    pub export_ids: AHashSet<ExportId>,
    pub name: String,
    pub source: SymbolWithSource,
    pub resolved_reference: ReferenceWithSource,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub dependencies: Vec<Dependency>,
    pub props: AHashMap<String, PropDefinition>,
    pub html_elements: AHashSet<String>,
    pub start: Option<CharacterPosition>,
    pub end: Option<CharacterPosition>,
}

impl Component {
    fn from_export(
        export: &Export,
        props: AHashMap<String, PropDefinition>,
        start: Option<CharacterPosition>,
        end: Option<CharacterPosition>,
    ) -> Self {
        let module_name = {
            let module_id = &export.module_id;
            let index_re = Regex::new(r"index.[jt]sx?$").unwrap();

            if module_id.path == "" {
                module_id.pkg_name.clone()
            } else {
                let file_name = module_id.path.file_name().unwrap();

                let resolution_path = if index_re.is_match(file_name) {
                    module_id.path.parent().map_or_else(
                        || RelativePathBuf::from(&module_id.pkg_name),
                        |parent| parent.to_relative_path_buf(),
                    )
                } else {
                    module_id.path.with_extension("")
                };

                String::from(resolution_path.file_name().unwrap())
            }
        };

        let name = if !export.name.starts_with(DEFAULT_EXPORT_NAME) {
            export.name.clone()
        } else if export.reference.reference.get_symbol().is_anonymous()
            || export.reference.reference.get_symbol().is_default()
        {
            module_name.clone()
        } else {
            export.reference.get_name()
        };

        let export_name = if export.name == DEFAULT_EXPORT_NAME {
            String::from("default")
        } else {
            name.clone()
        };

        let id = generate_definition_id(
            &export.module_id.pkg_name,
            &export.module_id.get_path_hash(),
            &export_name,
        );

        Self {
            id,
            export_ids: AHashSet::new(),
            name,
            source: SymbolWithSource::new(
                Symbol::from(export.name.as_str()),
                export.module_id.clone(),
            ),
            resolved_reference: export.reference.clone(),
            created_at: export.created_at,
            updated_at: export.updated_at,
            dependencies: vec![],
            props,
            html_elements: AHashSet::new(),
            start,
            end,
        }
    }

    fn from_external_symbol(symbol_with_source: &SymbolWithSource) -> Self {
        let symbol_name = symbol_with_source.symbol.get_name();
        let name = if symbol_name == DEFAULT_EXPORT_NAME {
            let src_path = symbol_with_source.source.path.to_string();

            if src_path == "" {
                symbol_with_source.source.pkg_name.clone()
            } else {
                src_path.split("/").last().unwrap().to_string()
            }
        } else {
            symbol_name.clone()
        };

        let export_name = if symbol_name == DEFAULT_EXPORT_NAME {
            String::from("default")
        } else {
            name.clone()
        };

        let id = generate_definition_id(
            &symbol_with_source.source.pkg_name,
            &symbol_with_source.source.get_path_hash(),
            &export_name,
        );

        Self {
            id,
            export_ids: AHashSet::new(),
            name,
            source: symbol_with_source.clone(),
            resolved_reference: symbol_with_source.clone().into(),
            created_at: None,
            updated_at: None,
            dependencies: vec![],
            props: AHashMap::new(),
            html_elements: AHashSet::new(),
            start: None,
            end: None,
        }
    }

    #[allow(dead_code)]
    fn is_local(&self) -> bool {
        self.source.is_local()
    }

    #[allow(dead_code)]
    fn is_external(&self) -> bool {
        self.source.is_external()
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct DependencyDatum {
    pub trace: Vec<ReferenceWithSource>,
    pub usages: Vec<Usage>,
}

impl DependencyDatum {
    pub fn new(trace: Vec<ReferenceWithSource>, usages: Vec<Usage>) -> Self {
        Self { trace, usages }
    }
}

#[derive(Serialize, Debug)]
pub struct AnalyzerResult {
    pub components: Vec<Component>,
    pub exports: Vec<Export>,
}

impl AnalyzerResult {
    pub fn get_num_of_dependencies(&self) -> usize {
        self.components.iter().map(|c| c.dependencies.len()).sum()
    }
}

const REACT_MODULE_NAME: &str = "react";
const REACT: &str = r#"
    export function Component() {
        return <div></div>;
    }

    export function PureComponent() {
        return <div></div>;
    }

    export function forwardRef() {
        return () => <div></div>;
    }

    export function memo() {
        return () => <div></div>;
    }

    export function lazy(callback) {
        return callback().default;
    }

    export default { forwardRef, memo, Component, PureComponent, lazy };
"#;

const PREACT_MODULE_NAME: &str = "preact";
const PREACT: &str = r#"
    export function Component() {
        return <div></div>;
    }

    export default { Component };
"#;
const PREACT_COMPAT_MODULE_NAME: &str = "preact/compat";
const PREACT_COMPAT: &str = r#"
    export function PureComponent() {
        return <div></div>;
    }

    export function forwardRef() {
        return () => <div></div>;
    }

    export function memo() {
        return () => <div></div>;
    }

    export function lazy(callback) {
        return callback().default;
    }

    export default { forwardRef, memo, PureComponent, lazy };
"#;

const LIT_REACT_MODULE_NAME: &str = "@lit/react";
const LIT_LABS_REACT_MODULE_NAME: &str = "@lit-labs/react";

const LIT_REACT: &str = r#"
    export function createComponent() {
        return () => <div></div>;
    }
"#;

const NEXT_DYNAMIC_MODULE_NAME: &str = "next/dynamic";
const NEXT_DYNAMIC: &str = r#"
    export default function(callback) {
        return callback().default;
    }
"#;

type DefaultModules = [Rc<RefCell<Module>>; 8];

#[derive(Debug)]
pub struct AnalyzerError {
    pub reason: String,
}

impl From<ParserError> for AnalyzerError {
    fn from(err: ParserError) -> Self {
        Self {
            reason: err.to_string(),
        }
    }
}

impl fmt::Display for AnalyzerError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Analysis failed: {}", self.reason)
    }
}

pub struct Analyzer {
    exports: AHashMap<String, Export>,
    components: AHashMap<ReferenceWithSource, Component>,
    module_resolver: Rc<ModuleResolver>,
    jsx_references: AHashSet<ReferenceWithSource>,
    modules: AHashMap<u64, Rc<RefCell<Module>>>,
    default_modules: DefaultModules,
    input_files: AHashSet<RelativePathBuf>,
}

impl Analyzer {
    fn resolve_export_recursive(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        reference_with_source: &ReferenceWithSource,
        trace: &mut Vec<ReferenceWithSource>,
        visited_modules: &mut AHashSet<ModuleId>,
        // This is for the recursion and needed to prioritize the first non-wildcard export
        // If you want to call this function outside of the recursion, you should pass None
        // To learn more about the usage, check the comments in the function body
        is_return_wildcard: &mut Option<bool>,
    ) -> Option<ReferenceWithSource> {
        trace.push(reference_with_source.clone());

        let module_id = &reference_with_source.source;
        trace!(
            "Searching for reference {} in {}",
            reference_with_source.reference,
            module_id.path
        );

        let module = modules.get(&module_id.hash);

        if module.is_none() {
            trace!("Cannot found module {}", module_id.path);
            return if module_id.is_external() {
                // There is no module for external packages; use the symbol with the input symbol instead.
                Some(reference_with_source.clone())
            } else {
                None
            };
        }

        let module = module.unwrap().as_ref().borrow();

        visited_modules.insert(module.id.clone());

        // handle with member properties, without changing name
        let export_name = reference_with_source.get_name();
        let export_name_with_member_properties =
            reference_with_source.get_name_with_member_properties();
        let export_by_name_with_member_properties =
            module.get_export_by_name(export_name_with_member_properties.as_str());
        let export_by_name = module.get_export_by_name(export_name.as_str());
        if let Some(export) = export_by_name_with_member_properties.or(export_by_name) {
            // If there is a named export, set the is_return_wildcard to false to prioritize it
            is_return_wildcard.replace(false);
            return match &export.source {
                ExportSource::External(s) => {
                    if s.source == *module_id {
                        trace!(
                            "Circular import from {} to {}",
                            module_id.path,
                            s.source.path
                        );

                        None
                    } else {
                        let mut reference_to_resolve = ReferenceWithSource::from(s.clone());
                        // Symbol is resolved by using reference's name
                        // We need to combine the member properties and the resolved symbol
                        if export_by_name_with_member_properties.is_none() {
                            for member_property in
                                reference_with_source.reference.get_member_properties()
                            {
                                reference_to_resolve
                                    .reference
                                    .push_member_property(member_property.clone());
                            }
                        }
                        Self::resolve_export_recursive(
                            modules,
                            &reference_to_resolve,
                            trace,
                            visited_modules,
                            &mut None,
                        )
                    }
                }
                ExportSource::Internal(is) => {
                    let mut reference_to_resolve = Reference::from(is.clone());
                    // Symbol is resolved by using reference's name
                    // We need to combine the member properties and the resolved symbol
                    if export_by_name_with_member_properties.is_none() {
                        for member_property in
                            reference_with_source.reference.get_member_properties()
                        {
                            reference_to_resolve.push_member_property(member_property.clone());
                        }
                    }
                    Self::resolve_internal_reference_recursive(
                        modules,
                        &ReferenceWithSource::new(reference_to_resolve, module_id.clone()),
                        trace,
                        visited_modules,
                    )
                }
            };
        }

        // Check for namespace-alias re-exports (e.g., Accordion.Root from export * as Accordion).
        // Synthesized exports from namespace aliases have dotted names without member properties,
        // so we check for a prefix that matches a namespace alias and resolve the remainder in
        // the target module.
        if !reference_with_source.reference.has_member_property() {
            if let Some(first_dot) = export_name.find('.') {
                let base_name = &export_name[..first_dot];
                let rest_name = &export_name[first_dot + 1..];
                if let Some(target_module_id) = module.get_namespace_export_target(base_name) {
                    if *target_module_id != *module_id && !visited_modules.contains(target_module_id) {
                        let mut sub_trace = vec![];
                        let new_reference = ReferenceWithSource::new(
                            Symbol::from(rest_name).into(),
                            target_module_id.clone(),
                        );
                        let result = Self::resolve_export_recursive(
                            modules,
                            &new_reference,
                            &mut sub_trace,
                            visited_modules,
                            &mut None,
                        );
                        if let Some(r) = result {
                            trace.extend(sub_trace);
                            return Some(r);
                        }
                    }
                }
            }
        }

        let mut first_result: Option<(ReferenceWithSource, Vec<ReferenceWithSource>)> = None;

        for exported_module in module.get_wildcard_exported_modules() {
            if visited_modules.contains(exported_module) {
                trace!(
                    "Circular import from {} to {}",
                    module_id.path,
                    exported_module.path,
                );
                continue;
            }

            let mut sub_trace = vec![];
            let reference_to_search = ReferenceWithSource::new(
                reference_with_source.reference.clone(),
                exported_module.clone(),
            );
            // Since we iterate over wildcard exports, the initial value of is_return_wildcard is true
            // when the recursion finds a non-wildcard export, it should set this value to false
            let mut sub_is_return_wildcard = Some(true);

            let result = Self::resolve_export_recursive(
                modules,
                &reference_to_search,
                &mut sub_trace,
                visited_modules,
                &mut sub_is_return_wildcard,
            );

            if result.is_some() {
                // If a named export is found, return it immediately
                if let Some(false) = sub_is_return_wildcard {
                    is_return_wildcard.replace(false);
                    trace.extend(sub_trace);
                    return result;
                }

                // otherwise, store the first wildcard export to return it if no named export is found
                if first_result.is_none() {
                    first_result = result.map(|r| (r, sub_trace));
                }
            }
        }

        if let Some((r, sub_trace)) = first_result {
            trace.extend(sub_trace);
            Some(r)
        } else {
            None
        }
    }
    fn resolve_export(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        reference_with_source: &ReferenceWithSource,
        trace: &mut Vec<ReferenceWithSource>,
    ) -> Option<ReferenceWithSource> {
        Self::resolve_export_recursive(
            modules,
            reference_with_source,
            trace,
            &mut AHashSet::new(),
            &mut None,
        )
    }

    fn resolve_internal_reference_recursive(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        reference_with_source: &ReferenceWithSource,
        trace: &mut Vec<ReferenceWithSource>,
        visited_modules: &mut AHashSet<ModuleId>,
    ) -> Option<ReferenceWithSource> {
        modules
            .get(&reference_with_source.source.hash)
            .map(|module| {
                module
                    .as_ref()
                    .borrow()
                    .resolve_reference(&reference_with_source.reference)
            })
            .and_then(|resolved| {
                if resolved.reference.is_wildcard()
                    || reference_with_source.source == resolved.source
                {
                    Some(resolved)
                } else {
                    Self::resolve_export_recursive(
                        modules,
                        &resolved,
                        trace,
                        visited_modules,
                        &mut None,
                    )
                }
            })
    }

    fn resolve_internal_reference(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        reference_with_source: &ReferenceWithSource,
        trace: &mut Vec<ReferenceWithSource>,
    ) -> Option<ReferenceWithSource> {
        Self::resolve_internal_reference_recursive(
            modules,
            reference_with_source,
            trace,
            &mut AHashSet::new(),
        )
    }

    fn resolve_reference(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        reference_with_source: &ReferenceWithSource,
        is_local: bool,
        trace: &mut Vec<ReferenceWithSource>,
    ) -> Option<ReferenceWithSource> {
        if is_local {
            Self::resolve_internal_reference(modules, reference_with_source, trace)
        } else {
            Self::resolve_export(modules, reference_with_source, trace)
        }
    }

    fn resolve_parameter(
        inferred_type: &Rc<InferredType>,
        argument_map: &AHashMap<ReferenceWithSource, Vec<Rc<InferredType>>>,
    ) -> Rc<InferredType> {
        match inferred_type.as_ref() {
            InferredType::ParameterOf { function, index } => argument_map
                .get(&function.clone().into())
                .and_then(|arguments| arguments.get(*index))
                .map_or_else(
                    || Rc::new(InferredType::Unknown),
                    |result| Self::resolve_parameter(result, argument_map),
                ),

            _ => Rc::clone(inferred_type),
        }
    }

    fn get_references_from_inferred_type_recursive(
        &self,
        inferred_type: &Rc<InferredType>,
        argument_map: &mut AHashMap<ReferenceWithSource, Vec<Rc<InferredType>>>,
        visited_functions: &mut AHashSet<ReferenceWithSource>,
    ) -> AHashMap<ReferenceWithSource, bool> {
        match inferred_type.as_ref() {
            InferredType::ReturnTypeOf(callee, arguments) => {
                let function_reference = InferredType::to_reference_with_source(callee).and_then(
                    |(reference, is_local)| {
                        Self::resolve_reference(&self.modules, &reference, is_local, &mut vec![])
                    },
                );

                if let Some(reference) = function_reference.clone() {
                    if visited_functions.contains(&reference) {
                        return AHashMap::new();
                    }

                    // Here, we insert the function reference and its arguments into the argument_map.
                    // This is necessary because we need to remember the arguments of the functions we have visited,
                    // so that we can resolve them later when we encounter the same function again.
                    argument_map.insert(
                        reference.clone(),
                        arguments
                            .iter()
                            .map(|arg| {
                                InferredType::to_reference_with_source(arg)
                                    .and_then(|(reference, is_local)| {
                                        Self::resolve_reference(
                                            &self.modules,
                                            &reference,
                                            is_local,
                                            &mut vec![],
                                        )
                                    })
                                    .map_or_else(
                                        || Rc::clone(arg),
                                        |r| {
                                            Self::get_inferred_type(
                                                &self.modules,
                                                &r.source,
                                                &r.reference,
                                            )
                                        },
                                    )
                            })
                            .collect(),
                    );

                    visited_functions.insert(reference);
                }

                // Here, we use the argument_map to resolve the parameters of the function.
                // This is necessary because the parameters of the function might depend on the arguments of the functions we have visited before.
                let resolved_function = Self::resolve_parameter(
                    &function_reference.map_or_else(
                        || Rc::clone(callee),
                        |r| Self::get_inferred_type(&self.modules, &r.source, &r.reference),
                    ),
                    argument_map,
                );

                match resolved_function.as_ref() {
                    InferredType::Function(return_types) => return_types
                        .iter()
                        .flat_map(|return_type| {
                            self.get_references_from_inferred_type_recursive(
                                return_type,
                                argument_map,
                                visited_functions,
                            )
                        })
                        .collect(),
                    _ => AHashMap::new(),
                }
            }
            InferredType::MemberOf(obj, member_property) => self
                .get_references_from_inferred_type_recursive(obj, argument_map, visited_functions)
                .iter()
                .map(|(reference_with_source, is_local)| {
                    let mut result = reference_with_source.clone();
                    result.push_member_property(member_property.clone());
                    (result, is_local.clone())
                })
                .collect(),
            InferredType::Union(types) => types
                .iter()
                .flat_map(|inferred_type| {
                    self.get_references_from_inferred_type_recursive(
                        inferred_type,
                        argument_map,
                        visited_functions,
                    )
                })
                .collect(),
            _ => InferredType::to_reference_with_source(inferred_type).map_or_else(
                || AHashMap::new(),
                |(reference, is_local)| {
                    let mut result = AHashMap::new();
                    result.insert(reference, is_local);
                    result
                },
            ),
        }
    }

    fn get_references_from_inferred_type(
        &self,
        inferred_type: &Rc<InferredType>,
    ) -> AHashMap<ReferenceWithSource, bool> {
        self.get_references_from_inferred_type_recursive(
            inferred_type,
            &mut AHashMap::new(),
            &mut AHashSet::new(),
        )
    }

    fn collect_references(
        &self,
        symbol_with_source: SymbolWithSource,
    ) -> AHashMap<ReferenceWithSource, AHashMap<Vec<ReferenceWithSource>, AHashSet<Usage>>> {
        let mut refs = AHashMap::new();

        trace!(
            "Find refs used in {} ({})",
            symbol_with_source.symbol,
            symbol_with_source.source.path
        );

        let result = self.modules.get(&symbol_with_source.source.hash);
        if result.is_none() {
            trace!("Couldn't find module {}", symbol_with_source.source.path);
            return refs;
        }

        let module = result.unwrap().as_ref().borrow();
        let mut symbols_to_visit = vec![symbol_with_source.clone()];
        let mut visited_symbols = AHashSet::new();

        while let Some(sym) = symbols_to_visit.pop() {
            let usage_map = module.get_usage_map(&sym.symbol);
            let mut refs_in_sym: AHashMap<ReferenceWithSource, bool> = module
                .get_all_references_in(&sym.symbol)
                .iter()
                .map(|r| (ReferenceWithSource::new(r.clone(), module.id.clone()), true))
                .collect();

            refs_in_sym.extend(
                self.get_references_from_inferred_type(&Self::get_inferred_type(
                    &self.modules,
                    &sym.source,
                    &sym.symbol.clone().into(),
                )),
            );

            visited_symbols.insert(sym);

            for (reference, is_local) in refs_in_sym {
                let mut trace = vec![];

                let resolved_reference =
                    Self::resolve_reference(&self.modules, &reference, is_local, &mut trace);

                if resolved_reference.is_none() {
                    trace!(
                        "Reference couldn't be resolved:{}@{}",
                        reference.reference,
                        reference.source.path
                    );
                    continue;
                }

                let resolved_reference = resolved_reference.unwrap();

                if self.components.contains_key(&resolved_reference) {
                    let usages = usage_map
                        .get(&reference.reference)
                        .map_or(AHashSet::new(), |p| p.clone());

                    refs.entry(resolved_reference)
                        .or_insert(AHashMap::new())
                        .entry(trace)
                        .or_insert(AHashSet::new())
                        .extend(usages.into_iter());
                } else {
                    trace!(
                        "Dependency is not a component:{}@{}\n{:#?}",
                        resolved_reference.reference,
                        resolved_reference.source.path,
                        trace
                    );
                    let resolved_symbol = SymbolWithSource::from(resolved_reference.clone());

                    if module.id == resolved_reference.source
                        && !resolved_reference.has_member_property()
                        && !visited_symbols.contains(&resolved_symbol)
                    {
                        symbols_to_visit.push(resolved_symbol);
                    }
                }
            }
        }
        refs
    }

    fn get_dependencies_of(&self, component: &Component) -> AHashSet<Dependency> {
        let mut deps = AHashSet::new();
        let reference = &component.resolved_reference;

        if reference.is_external() {
            trace!(
                "{} is an external component. Skip getting dependencies",
                component.id
            );
            return deps;
        }

        if reference.has_member_property() {
            trace!(
                "{} is a sub component. Skip getting dependencies",
                component.id
            );
            return deps;
        }

        let result = self.modules.get(&reference.source.hash);
        if result.is_none() {
            trace!("Couldn't find module {}", reference.source.path);
            return deps;
        }
        let refs = self.collect_references(reference.clone().into());

        for (r, reference_map) in refs {
            if let Some(comp) = self.components.get(&r) {
                if component.source != comp.source {
                    deps.insert(Dependency::new(
                        component,
                        comp,
                        reference_map
                            .into_iter()
                            .map(|(trace, usages)| {
                                DependencyDatum::new(trace, usages.into_iter().collect())
                            })
                            .collect(),
                    ));
                }
            } else {
                trace!(
                    "Dependency is not a component:{}@{}",
                    r.reference,
                    r.source.path
                );
            }
        }

        deps
    }

    pub fn new(
        input_modules: &[Rc<RefCell<Module>>],
        module_resolver: &Rc<ModuleResolver>,
        input_files: Vec<RelativePathBuf>,
        add_default_libraries: bool,
    ) -> Result<Self, AnalyzerError> {
        let exports = AHashMap::new();
        let components = AHashMap::new();
        let mut jsx_references = AHashSet::new();
        let mut modules = AHashMap::new();

        trace!(
            "Creating analyzer for input {} modules",
            input_modules.len()
        );

        for m in input_modules {
            modules.insert(m.as_ref().borrow().id.hash, Rc::clone(m));
        }

        let default_modules = [
            Rc::new(RefCell::new(Module::new_from_code(
                REACT,
                REACT_MODULE_NAME,
                ModuleType::Package,
                REACT_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                PREACT,
                PREACT_MODULE_NAME,
                ModuleType::Package,
                PREACT_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                PREACT_COMPAT,
                PREACT_COMPAT_MODULE_NAME,
                ModuleType::Package,
                PREACT_COMPAT_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                STYLED_COMPONENTS,
                STYLED_COMPONENTS_MODULE_NAME,
                ModuleType::Package,
                STYLED_COMPONENTS_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                STYLED_COMPONENTS,
                STYLED_COMPONENTS_MACRO_MODULE_NAME,
                ModuleType::Package,
                STYLED_COMPONENTS_MACRO_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                LIT_REACT,
                LIT_REACT_MODULE_NAME,
                ModuleType::Package,
                LIT_REACT_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                LIT_REACT,
                LIT_LABS_REACT_MODULE_NAME,
                ModuleType::Package,
                LIT_LABS_REACT_MODULE_NAME,
            )?)),
            Rc::new(RefCell::new(Module::new_from_code(
                NEXT_DYNAMIC,
                NEXT_DYNAMIC_MODULE_NAME,
                ModuleType::Package,
                NEXT_DYNAMIC_MODULE_NAME,
            )?)),
        ];

        if add_default_libraries {
            for m in default_modules.iter() {
                let module = m.as_ref().borrow();
                modules.insert(module.id.hash, Rc::clone(m));
            }
        }

        for m in input_modules {
            let module = m.as_ref().borrow();
            jsx_references.extend(module.get_jsx_references().iter().filter_map(|r| {
                Self::resolve_internal_reference(
                    &modules,
                    &ReferenceWithSource::new(r.clone(), module.id.clone()),
                    &mut vec![],
                )
            }));
        }

        Ok(Self {
            exports,
            module_resolver: module_resolver.clone(),
            jsx_references,
            components,
            modules,
            default_modules,
            input_files: AHashSet::from_iter(input_files),
        })
    }

    fn get_inferred_type(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        module_id: &ModuleId,
        reference: &Reference,
    ) -> Rc<InferredType> {
        if reference.is_wildcard() {
            Rc::new(InferredType::TypeOf {
                symbol: SymbolWithSource::new(reference.get_symbol().clone(), module_id.clone()),
                is_local: false,
            })
        } else {
            modules.get(&module_id.hash).map_or_else(
                || Rc::new(InferredType::Unknown),
                |module| module.as_ref().borrow().get_inferred_type(&reference),
            )
        }
    }

    fn new_export_from(
        &self,
        module_id: &ModuleId,
        module_export: &ModuleExport,
    ) -> Option<Export> {
        let mut trace = vec![];
        debug!(
            "Resolving {} from {}",
            module_export.exported_name, module_id.path
        );

        let result = Self::resolve_export(
            &self.modules,
            &ReferenceWithSource::new(
                Symbol::from(module_export.exported_name.as_str()).into(),
                module_id.clone(),
            ),
            &mut trace,
        )
        .map(|r| {
            (
                r.clone(),
                Self::get_inferred_type(&self.modules, &r.source, &r.reference),
            )
        });

        if let Some((reference, inferred_type)) = result {
            trace!("Reference: {:#?}", reference);
            trace!("Inferred type: {:#?}", inferred_type);

            let module = if let Some(m) = self.modules.get(&module_id.hash) {
                m.as_ref().borrow()
            } else {
                error!(
                    "Couldn't find module {} (hash: {})",
                    module_id.path, module_id.hash
                );
                return None;
            };

            Some(Export::new(
                module_id.clone(),
                module_export.exported_name.clone(),
                reference,
                module.created_at,
                module.updated_at,
                Rc::clone(&inferred_type),
                Analyzer::resolve_inferred_type(
                    &self.modules,
                    &inferred_type,
                    &mut AHashSet::new(),
                ),
                trace,
            ))
        } else {
            trace!(
                "Couldn't find {}:\n{:#?}",
                module_export.exported_name,
                &module_export
            );
            None
        }
    }

    fn expand_module_exports(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        processed_exports: &AHashMap<u64, AHashSet<Rc<ModuleExport>>>,
        module: &Rc<RefCell<Module>>,
        visited_modules: &mut AHashSet<u64>,
    ) -> AHashSet<Rc<ModuleExport>> {
        let mut module_exports: AHashSet<Rc<ModuleExport>> = AHashSet::new();
        let module = module.as_ref().borrow();

        visited_modules.insert(module.id.hash);

        debug!(
            "Expanding exports for {}: {:?}",
            module.id.path, visited_modules
        );

        // This is used for transforming exports from external modules while expanding wildcard exports (e.g. `export * from "./otherModule"`)
        // In the context of the module (e.g. `exportingModule.js`) that exports all names from the `otherModule`:
        //   - Local exports of `otherModule`, i.e. `export const X = () => {...}`,
        //     are transformed to exports of exportingModule.js such that ExportSource is external and source module is `otherModule`.
        //   - External symbols exported by `otherModule`, i.e. `export { X } from "./externalModule"` in `otherModule`, are copied directly.
        let transform_export = |export_src: &ModuleId, module_export: &Rc<ModuleExport>| {
            let source = match &module_export.source {
                ExportSource::External(external) => ExportSource::External(external.clone()),
                ExportSource::Internal(_) => ExportSource::External(SymbolWithSource::new(
                    Symbol::from(module_export.exported_name.as_str()),
                    export_src.clone(),
                )),
            };

            Rc::new(ModuleExport {
                source,
                exported_name: module_export.exported_name.clone(),
            })
        };

        for export in module.get_exports() {
            if let ExportSource::External(export_src) = &export.source {
                let source_hash = export_src.source.hash;

                if export_src.symbol.is_wildcard() {
                    if let Some(exports) = processed_exports.get(&source_hash) {
                        module_exports.extend(
                            exports
                                .iter()
                                .map(|ex| transform_export(&export_src.source, ex)),
                        );
                    } else if !visited_modules.contains(&source_hash) {
                        if let Some(module) = modules.get(&source_hash) {
                            let exports = Analyzer::expand_module_exports(
                                modules,
                                processed_exports,
                                module,
                                visited_modules,
                            );
                            module_exports.extend(
                                exports
                                    .iter()
                                    .map(|ex| transform_export(&export_src.source, ex)),
                            )
                        }
                    }
                } else {
                    module_exports.insert(Rc::clone(export));
                }
            } else {
                // Check if this is a namespace alias re-export (export * as X from './y').
                // Such exports are stored with an Internal source pointing to a local
                // declaration whose definition is an ExternalSymbol with a wildcard.
                let maybe_target_module = match &export.source {
                    ExportSource::Internal(symbol) => module.declarations.iter().find_map(|decl| {
                        if decl.symbol == *symbol {
                            if let Definition::ExternalSymbol(sym_with_src) = &decl.definition {
                                if sym_with_src.symbol.is_wildcard() {
                                    return Some(sym_with_src.source.clone());
                                }
                            }
                        }
                        None
                    }),
                    _ => None,
                };

                if let Some(target_module_id) = maybe_target_module {
                    let target_hash = target_module_id.hash;

                    let target_exports = if let Some(exports) = processed_exports.get(&target_hash) {
                        exports.clone()
                    } else if !visited_modules.contains(&target_hash) {
                        if let Some(target_module) = modules.get(&target_hash) {
                            Analyzer::expand_module_exports(
                                modules,
                                processed_exports,
                                target_module,
                                visited_modules,
                            )
                        } else {
                            AHashSet::new()
                        }
                    } else {
                        AHashSet::new()
                    };

                    let namespace_name = &export.exported_name;
                    if target_exports.is_empty() {
                        // If the target module can't be resolved (e.g., external package),
                        // keep the original namespace alias export.
                        module_exports.insert(Rc::clone(export));
                    } else {
                        for ex in target_exports.iter() {
                            let transformed = transform_export(&target_module_id, ex);
                            module_exports.insert(Rc::new(ModuleExport {
                                source: transformed.source.clone(),
                                exported_name: format!("{}.{}", namespace_name, transformed.exported_name),
                            }));
                        }
                    }
                } else {
                    module_exports.insert(Rc::clone(export));
                }
            }
        }

        module_exports
    }

    fn collect_exports(&mut self) {
        info!("First pass: Collecting exported declarations...");

        let mut expanded_exports: AHashMap<u64, AHashSet<Rc<ModuleExport>>> = AHashMap::new();

        for (_, module) in self.modules.iter() {
            let result = Analyzer::expand_module_exports(
                &self.modules,
                &expanded_exports,
                module,
                &mut AHashSet::new(),
            );

            expanded_exports.insert(module.as_ref().borrow().id.hash, result);
        }

        for (id, exports) in expanded_exports.iter() {
            let m = if let Some(m) = self.modules.get(id) {
                m.as_ref().borrow()
            } else {
                error!("Couldn't find module (id: {})", id);
                continue;
            };

            trace!(
                "Reading exports of {} ({})",
                m.id.path.to_string(),
                exports.len()
            );

            for ex in exports.iter() {
                trace!(
                    "Processing export item: name={} path={} hash={}",
                    ex.exported_name,
                    m.id.path,
                    m.id.hash
                );

                if let Some(export_item) = self.new_export_from(&m.id, ex) {
                    self.exports.insert(export_item.get_hash_key(), export_item);
                } else {
                    trace!("Couldn't create export for {:?}", ex);
                }
                trace!("==================================");
            }
        }
    }

    fn resolve_inferred_type(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        inferred_type: &Rc<InferredType>,
        visited_symbols: &mut AHashSet<SymbolWithSource>,
    ) -> Rc<InferredType> {
        match inferred_type.deref() {
            InferredType::TypeOf { symbol, is_local } => {
                if visited_symbols.contains(&symbol) {
                    return Rc::new(InferredType::Unknown);
                }

                visited_symbols.insert(symbol.clone());

                if symbol.symbol.is_wildcard() {
                    return Rc::clone(&inferred_type);
                }

                let resolved_reference = Self::resolve_reference(
                    modules,
                    &symbol.clone().into(),
                    *is_local,
                    &mut vec![],
                );

                resolved_reference.map_or_else(
                    || Rc::new(InferredType::Unknown),
                    |r| {
                        Analyzer::resolve_inferred_type(
                            modules,
                            &Self::get_inferred_type(modules, &r.source, &r.reference),
                            visited_symbols,
                        )
                    },
                )
            }
            InferredType::Class(super_class_type) => Rc::new(InferredType::Class(
                Analyzer::resolve_inferred_type(modules, super_class_type, visited_symbols),
            )),
            InferredType::Function(return_types) => Rc::new(InferredType::Function(
                return_types
                    .iter()
                    .map(|return_type| {
                        Analyzer::resolve_inferred_type(modules, return_type, visited_symbols)
                    })
                    .collect(),
            )),
            InferredType::ReturnTypeOf(callable_type, arg_types) => {
                Rc::new(InferredType::ReturnTypeOf(
                    Analyzer::resolve_inferred_type(modules, callable_type, visited_symbols),
                    arg_types
                        .iter()
                        .map(|t| Analyzer::resolve_inferred_type(modules, t, visited_symbols))
                        .collect(),
                ))
            }
            InferredType::Union(types) => Rc::new(InferredType::Union(
                types
                    .iter()
                    .map(|t| Analyzer::resolve_inferred_type(modules, t, visited_symbols))
                    .collect(),
            )),
            InferredType::Object(types) => Rc::new(InferredType::Object(AHashMap::from_iter(
                types.iter().map(|(k, t)| {
                    (
                        k.clone(),
                        Analyzer::resolve_inferred_type(modules, t, visited_symbols),
                    )
                }),
            ))),
            InferredType::Array(types) => Rc::new(InferredType::Array(
                types
                    .iter()
                    .map(|t| Analyzer::resolve_inferred_type(modules, t, visited_symbols))
                    .collect(),
            )),
            InferredType::MemberOf(obj_type, member_property) => match obj_type.as_ref() {
                InferredType::TypeOf { symbol, is_local } => {
                    if !*is_local && symbol.symbol.is_wildcard() {
                        Rc::clone(&inferred_type)
                    } else {
                        Rc::new(InferredType::MemberOf(
                            Analyzer::resolve_inferred_type(modules, obj_type, visited_symbols),
                            member_property.clone(),
                        ))
                    }
                }
                _ => Rc::new(InferredType::MemberOf(
                    Analyzer::resolve_inferred_type(modules, obj_type, visited_symbols),
                    member_property.clone(),
                )),
            },
            InferredType::ParameterOf { .. } => Rc::new(InferredType::Unknown),
            InferredType::JSX | InferredType::Str(_) | InferredType::Unknown => {
                Rc::clone(&inferred_type)
            }
        }
    }

    fn eval_member_of(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        container: Rc<InferredType>,
        member_property: &MemberProperty,
    ) -> Rc<InferredType> {
        match container.deref() {
            InferredType::TypeOf { symbol, .. } => {
                if let MemberProperty::Object(key) = member_property {
                    let reference = Self::resolve_export(
                        modules,
                        &ReferenceWithSource::new(
                            Symbol::from(key.as_str()).into(),
                            symbol.source.clone(),
                        ),
                        &mut vec![],
                    );

                    reference.map_or_else(
                        || Rc::new(InferredType::Unknown),
                        |r| {
                            Analyzer::eval_inferred_type(
                                modules,
                                Analyzer::resolve_inferred_type(
                                    modules,
                                    &Self::get_inferred_type(modules, &r.source, &r.reference),
                                    &mut AHashSet::new(),
                                ),
                            )
                        },
                    )
                } else {
                    Rc::new(InferredType::Unknown)
                }
            }
            InferredType::Object(obj) => {
                if let MemberProperty::Object(key) = member_property {
                    obj.get(key).map_or(Rc::new(InferredType::Unknown), |v| {
                        Analyzer::eval_inferred_type(modules, Rc::clone(v))
                    })
                } else {
                    // Invalid member property
                    Rc::new(InferredType::Unknown)
                }
            }
            InferredType::Array(arr) => {
                if let MemberProperty::Array(idx) = member_property {
                    arr.get(*idx).map_or(Rc::new(InferredType::Unknown), |v| {
                        Analyzer::eval_inferred_type(modules, Rc::clone(v))
                    })
                } else {
                    // Invalid member property
                    Rc::new(InferredType::Unknown)
                }
            }
            InferredType::Union(types) => Rc::new(InferredType::Union(
                types
                    .iter()
                    .map(|t| Analyzer::eval_member_of(modules, Rc::clone(t), member_property))
                    .collect(),
            )),
            _ => Rc::new(InferredType::Unknown),
        }
    }

    fn is_unknown(inferred_type: &InferredType) -> bool {
        match inferred_type {
            InferredType::Class(super_class_type) => Analyzer::is_unknown(super_class_type),
            InferredType::Function(return_types) => {
                return_types.iter().any(|rt| Analyzer::is_unknown(rt))
            }
            InferredType::ReturnTypeOf(callable, _) => Analyzer::is_unknown(callable),
            InferredType::Union(types) => types.iter().any(|t| Analyzer::is_unknown(t)),
            InferredType::Object(_) => false,
            InferredType::Array(_) => false,
            InferredType::JSX => false,
            InferredType::Str(_) => false,
            InferredType::MemberOf(..) => {
                error!("Unexpected InferredType: Memberof. It should be resolved to other types before here.");
                true
            }
            InferredType::TypeOf { .. } => {
                error!("Unexpected InferredType: TypeOf. It should be resolved to other types before here.");
                true
            }
            InferredType::ParameterOf { .. } => {
                error!("Unexpected InferredType: ParameterOf. It should be resolved to other types before here.");
                true
            }
            InferredType::Unknown => true,
        }
    }

    fn eval_return_of(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        callable: Rc<InferredType>,
        args: &Vec<Rc<InferredType>>,
    ) -> Rc<InferredType> {
        let eval_types = |types: &Vec<Rc<InferredType>>| -> Vec<Rc<InferredType>> {
            types
                .iter()
                .map(|t| {
                    let inferred_type = Analyzer::eval_inferred_type(modules, Rc::clone(t));

                    if let InferredType::Union(types) = inferred_type.deref() {
                        types.clone()
                    } else {
                        vec![inferred_type]
                    }
                })
                .flatten()
                .collect()
        };

        match Analyzer::eval_inferred_type(modules, callable).deref() {
            InferredType::Function(return_types) => {
                let mut result = eval_types(return_types);
                if result.iter().any(|r| Analyzer::is_unknown(r)) {
                    result.extend(eval_types(args));
                }
                Rc::new(InferredType::Union(result))
            }
            InferredType::Union(types) => {
                let mut result = eval_types(types);
                result = result
                    .iter()
                    .map(|t| Rc::new(InferredType::ReturnTypeOf(Rc::clone(t), vec![])))
                    .collect();
                if result.iter().any(|r| Analyzer::is_unknown(r)) {
                    result.extend(eval_types(args));
                }

                Rc::new(InferredType::Union(result))
            }
            _ => {
                let mut types = eval_types(args);
                types.push(Rc::new(InferredType::Unknown));
                Rc::new(InferredType::Union(types))
            }
        }
    }

    fn eval_inferred_type(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        inferred_type: Rc<InferredType>,
    ) -> Rc<InferredType> {
        match inferred_type.deref() {
            InferredType::Class(sc) => Rc::new(InferredType::Class(Analyzer::eval_inferred_type(
                modules,
                Rc::clone(sc),
            ))),
            InferredType::Function(rt) => Rc::new(InferredType::Function(
                rt.iter()
                    .map(|t| Analyzer::eval_inferred_type(modules, Rc::clone(t)))
                    .collect(),
            )),
            InferredType::Object(types) => Rc::new(InferredType::Object(AHashMap::from_iter(
                types.iter().map(|(k, t)| {
                    (
                        k.clone(),
                        Analyzer::eval_inferred_type(modules, Rc::clone(t)),
                    )
                }),
            ))),
            InferredType::Array(types) => Rc::new(InferredType::Array(
                types
                    .iter()
                    .map(|t| Analyzer::eval_inferred_type(modules, Rc::clone(t)))
                    .collect(),
            )),
            InferredType::JSX
            | InferredType::Str(_)
            | InferredType::TypeOf { .. }
            | InferredType::Unknown => Rc::clone(&inferred_type),
            InferredType::ParameterOf { .. } => Rc::new(InferredType::Unknown),
            InferredType::ReturnTypeOf(callable, args) => {
                Analyzer::eval_return_of(modules, Rc::clone(callable), args)
            }
            InferredType::MemberOf(container, member_property) => Analyzer::eval_member_of(
                modules,
                Analyzer::eval_inferred_type(modules, Rc::clone(container)),
                &member_property,
            ),
            InferredType::Union(types) => Rc::new(InferredType::Union(
                types
                    .iter()
                    .map(|t| Analyzer::eval_inferred_type(modules, Rc::clone(t)))
                    .collect(),
            )),
        }
    }

    fn has_jsx(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        inferred_type: Rc<InferredType>,
    ) -> bool {
        match inferred_type.deref() {
            InferredType::Union(type_vec) => type_vec
                .iter()
                .any(|inferred_type| Analyzer::has_jsx(modules, Rc::clone(inferred_type))),
            InferredType::ReturnTypeOf(callable, _) => {
                Analyzer::is_component(modules, Rc::clone(callable))
            }
            InferredType::MemberOf(..) => Analyzer::has_jsx(
                modules,
                Analyzer::eval_inferred_type(modules, inferred_type),
            ),
            InferredType::JSX => true,
            _ => false,
        }
    }

    fn is_component(
        modules: &AHashMap<u64, Rc<RefCell<Module>>>,
        resolved_type: Rc<InferredType>,
    ) -> bool {
        match resolved_type.deref() {
            InferredType::Union(type_vec) => type_vec.iter().any(|inferred_type| {
                Analyzer::is_component(
                    modules,
                    Analyzer::eval_inferred_type(modules, Rc::clone(inferred_type)),
                )
            }),
            InferredType::Class(super_class_type) => Analyzer::is_component(
                modules,
                Analyzer::eval_inferred_type(modules, Rc::clone(super_class_type)),
            ),
            InferredType::Function(return_types) => return_types.iter().any(|return_type| {
                Analyzer::has_jsx(
                    modules,
                    Analyzer::eval_inferred_type(modules, Rc::clone(return_type)),
                )
            }),
            InferredType::ReturnTypeOf(..) => Analyzer::is_component(
                modules,
                Analyzer::eval_inferred_type(modules, resolved_type),
            ),
            InferredType::MemberOf(..) => Analyzer::is_component(
                modules,
                Analyzer::eval_inferred_type(modules, resolved_type),
            ),
            InferredType::TypeOf { .. } => {
                debug!("Unresolved type: {:#?}", resolved_type);
                false
            }
            InferredType::Object(_)
            | InferredType::ParameterOf { .. }
            | InferredType::Array(_)
            | InferredType::JSX
            | InferredType::Str(_)
            | InferredType::Unknown => false,
        }
    }

    fn collect_components(&mut self) {
        info!("Second pass: Collecting components...");

        for jsx_reference in &self.jsx_references {
            // If the resolved reference has no member properties, is external, and is not added as external,
            // add it as a component.
            if !jsx_reference.has_member_property()
                && jsx_reference.is_external()
                && !self.components.contains_key(&jsx_reference)
            {
                let component = Component::from_external_symbol(&jsx_reference.clone().into());

                self.components.insert(jsx_reference.clone(), component);
            }
        }

        loop {
            let mut updated = false;

            for (_, export_item) in self.exports.iter_mut() {
                if export_item.is_component {
                    continue;
                }

                let r = export_item.reference.clone();

                debug!("Checking if exported symbol is component {:?}", r);
                if self.jsx_references.contains(&r)
                    || Analyzer::is_component(&self.modules, Rc::clone(&export_item.resolved_type))
                {
                    export_item.mark_as_component();

                    self.jsx_references.insert(r);

                    updated = true;
                }
            }

            if !updated {
                break;
            }
        }

        let mut sorted_exports = self.exports.iter().collect::<Vec<_>>();
        sorted_exports.sort_by(|(_, e1), (_, e2)| {
            let mid_ord = e1.module_id.pkg_name.cmp(&e2.module_id.pkg_name);
            match mid_ord {
                Ordering::Equal => {
                    let path_ord = e1.module_id.path.cmp(&e2.module_id.path);
                    match path_ord {
                        Ordering::Equal => {
                            if e1.name == e2.name {
                                Ordering::Equal
                            } else if e1.name == *DEFAULT_EXPORT_NAME {
                                Ordering::Less
                            } else if e2.name == *DEFAULT_EXPORT_NAME {
                                Ordering::Greater
                            } else if !e1.name.contains(".") && e2.name.contains(".") {
                                // prioritize non-subcomponent names
                                Ordering::Greater
                            } else if e1.name.contains(".") && !e2.name.contains(".") {
                                Ordering::Less
                            } else {
                                e1.name.cmp(&e2.name)
                            }
                        }
                        _ => path_ord,
                    }
                }
                _ => mid_ord,
            }
        });

        let unique_exports: AHashMap<ReferenceWithSource, &Export> =
            AHashMap::from_iter(sorted_exports.iter().filter_map(|(_, export_item)| {
                if export_item.is_component && export_item.module_id == export_item.reference.source
                {
                    trace!(
                        "Export {:?}: {:#?}",
                        export_item.name,
                        &export_item.reference
                    );

                    Some((export_item.reference.clone(), *export_item))
                } else {
                    None
                }
            }));

        let components = unique_exports.into_iter().map(|(source, exp)| {
            let module_hash = source.source.hash;
            let reference = source.reference.clone();

            let props = self.modules.get(&module_hash).map_or_else(
                || AHashMap::new(),
                |module| module.borrow().get_prop_definitions(&reference),
            );

            let declaration = self
                .modules
                .get(&module_hash)
                .and_then(|module| module.borrow().get_declaration(reference.get_symbol()));

            let (start_pos, end_pos) =
                declaration.map_or((None, None), |decl| (decl.start.clone(), decl.end.clone()));

            (
                source,
                Component::from_export(exp, props, start_pos, end_pos),
            )
        });

        self.components.extend(components);

        self.components.retain(|s, _| {
            self.default_modules
                .iter()
                .all(|m| s.source != m.as_ref().borrow().id)
        })
    }

    fn extract_dependencies(&self) -> AHashMap<SymbolWithSource, AHashSet<Dependency>> {
        info!("Third pass: Extracting dependencies");
        let mut dep_map: AHashMap<SymbolWithSource, AHashSet<Dependency>> = AHashMap::new();

        for (_, component) in self.components.iter() {
            let symbol = &component.source;
            let deps: AHashSet<Dependency> = self.get_dependencies_of(component);

            dep_map.insert(symbol.clone(), deps);
        }

        dep_map
    }

    fn collect_html_elements_in(&mut self, component: &mut Component) {
        let resolved_ref = &component.resolved_reference;
        if let Some(m) = self.modules.get(&resolved_ref.source.hash) {
            m.borrow()
                .get_html_elements_in(resolved_ref.reference.get_symbol())
                .iter()
                .for_each(|it| {
                    let inferred_type = Analyzer::eval_inferred_type(
                        &self.modules,
                        Analyzer::resolve_inferred_type(&self.modules, &it, &mut AHashSet::new()),
                    );

                    let mut add_html_element = |value: &str| {
                        if is_html_element(value) {
                            component.html_elements.insert(value.to_string());
                        }
                    };

                    match inferred_type.as_ref() {
                        InferredType::Str(value) => {
                            add_html_element(value);
                        }
                        InferredType::Union(types) => {
                            types.into_iter().for_each(|t| match t.as_ref() {
                                InferredType::Str(value) => {
                                    add_html_element(value);
                                }
                                _ => {}
                            });
                        }
                        _ => {}
                    }
                });
        };
    }

    fn get_result(&mut self) -> AnalyzerResult {
        let mut exports: Vec<Export> = (&mut self.exports).drain().map(|(_, eit)| eit).collect();

        exports.retain(|export| {
            self.default_modules
                .iter()
                .all(|m| export.module_id != m.as_ref().borrow().id)
        });

        exports.sort_by(|a, b| {
            let cmp_result = a.module_id.path.cmp(&b.module_id.path);
            match cmp_result {
                Ordering::Equal => a.name.cmp(&b.name),
                _ => cmp_result,
            }
        });

        let mut export_map = self.module_resolver.get_export_map(&exports);

        let mut dep_map = self.extract_dependencies();

        for (_, component) in self.components.iter_mut() {
            component.export_ids = export_map
                .remove(&component.resolved_reference)
                .unwrap_or_default();

            component
                .dependencies
                .extend(dep_map.remove(&component.source).unwrap_or_default());

            component
                .dependencies
                .sort_by(|a, b| a.to.source.cmp(&b.to.source));
        }

        // Collect list of components which are either included in the input files or external dependencies of included components
        let mut included_component_sources: AHashSet<SymbolWithSource> = AHashSet::new();
        for component in self.components.values() {
            if self.input_files.contains(&component.source.source.path) {
                included_component_sources.insert(component.source.clone());

                for dep in &component.dependencies {
                    if dep.to.is_external() {
                        included_component_sources.insert(dep.to.source.clone());
                    }
                }
            }
        }

        let mut components: Vec<Component> = self
            .components
            .drain()
            .filter_map(|(_, component)| {
                if included_component_sources.contains(&component.source) {
                    Some(component)
                } else {
                    None
                }
            })
            .collect();

        components.sort_by(|a, b| a.source.cmp(&b.source));

        for component in components.iter_mut() {
            debug!(
                "Collecting HTML elements in {} - {}",
                component.id, component.source.source.path
            );
            self.collect_html_elements_in(component);

            component.dependencies.retain(|dependency|
                // retain dependencies which are from included files
                included_component_sources.contains(&dependency.to.source));
        }

        // eliminate irrelevant exports
        exports.retain(|export| {
            export
                .trace_to_declaration
                .iter()
                .any(|sws| self.input_files.contains(&sws.source.path))
        });

        info!(
            "Done: components = {}, exports = {}",
            components.len(),
            exports.len()
        );

        AnalyzerResult {
            components,
            exports,
        }
    }

    pub fn analyze(&mut self) -> AnalyzerResult {
        self.collect_exports();
        self.collect_components();

        trace!("JSX refs: {:#?}", self.jsx_references);

        self.get_result()
    }
}
