use std::{fmt, path::Path, rc::Rc};

use ahash::{AHashMap, AHashSet};
use logger::{debug, trace};
use relative_path::{RelativePath, RelativePathBuf};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use swc::{
    common::{errors::Handler, sync::Lrc, FileName, SourceFile, SourceMap},
    config::{Config, IsModule, JscConfig, Options},
    Compiler,
};
use swc_common::errors::{Diagnostic, DiagnosticBuilder, Emitter, HandlerFlags};
use swc_ecmascript::{
    ast::{EsVersion, Module as SwcModule, ModuleItem, Program, Script},
    parser::{Syntax, TsConfig},
    visit::Fold,
};

mod inspector;
pub mod symbol;

pub use inspector::{
    CharacterPosition, Definition, ExportSource, InferredType, ModuleExport, ObjectPropValue,
    PropDefinition, PropUsage, PropValue, Reference, ReferenceWithSource, SymbolWithSource, Usage,
};

use inspector::{Declaration, Inspector, PropDefinitionFinder, ReferenceScopePtr};
pub use symbol::Symbol;

use crate::module_resolver::{ModuleId, ModuleResolver, ModuleType};

fn noop() -> impl Fold {
    Noop
}

struct Noop;
impl Fold for Noop {
    #[inline(always)]
    fn fold_module(&mut self, m: SwcModule) -> SwcModule {
        m
    }

    #[inline(always)]
    fn fold_script(&mut self, s: Script) -> Script {
        s
    }
}

#[derive(Debug, Serialize)]
pub struct ParserError {
    pub reason: Vec<String>,
    pub file: String,
}

impl ParserError {
    pub fn new(reason: Vec<String>, file: String) -> Self {
        ParserError { reason, file }
    }
}

impl fmt::Display for ParserError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Parser error: {}", self.reason.join("\n"))
    }
}

#[derive(Serialize)]
pub struct Module {
    pub source_path: RelativePathBuf,
    pub id: ModuleId,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub exports: Vec<Rc<ModuleExport>>,
    pub declarations: Vec<Rc<Declaration>>,
    pub scopes: Vec<Rc<ReferenceScopePtr>>,
    pub body: Vec<ModuleItem>,
    #[serde(skip_serializing)]
    source_map: Arc<SourceMap>,
}

#[derive(Clone, Debug, Default)]
struct ErrorEmitter(Lrc<RwLock<Vec<Diagnostic>>>);

impl Emitter for ErrorEmitter {
    fn emit(&mut self, db: &DiagnosticBuilder) {
        self.0.write().unwrap().push((**db).clone());
    }
}

impl From<ErrorEmitter> for Vec<Diagnostic> {
    fn from(buf: ErrorEmitter) -> Self {
        let s = buf.0.read().unwrap();

        s.clone()
    }
}

fn collect_errors(error_emitter: &ErrorEmitter, source_map: &Lrc<SourceMap>) -> Vec<String> {
    let s = error_emitter.0.read().unwrap().clone();
    let diagnostics = s
        .iter()
        .map(|d| {
            let mut msg = d.message();

            if let Some(span) = d.span.primary_span() {
                let loc = source_map.lookup_char_pos(span.lo);

                msg = format!("{} at line {}:{}", msg, loc.line, loc.col_display);
            }

            msg
        })
        .collect::<Vec<String>>();

    diagnostics
}

pub fn parse_module(
    source_map: &Lrc<SourceMap>,
    source_file: &Lrc<SourceFile>,
) -> Result<SwcModule, ParserError> {
    let error_buffer = Box::new(ErrorEmitter::default());
    let handler = Lrc::new(Handler::with_emitter_and_flags(
        error_buffer.clone(),
        HandlerFlags {
            treat_err_as_bug: false,
            can_emit_warnings: true,
            dont_buffer_diagnostics: true,
            ..HandlerFlags::default()
        },
    ));
    let compiler = Compiler::new(source_map.clone());

    let result = compiler
        .parse_js_as_input(
            source_file.clone(),
            None,
            &handler,
            &Options {
                config: Config {
                    env: None,
                    exclude: None,
                    jsc: JscConfig {
                        syntax: Some(Syntax::Typescript(TsConfig {
                            tsx: true,
                            decorators: true,
                            ..Default::default()
                        })),
                        transform: None.into(),
                        external_helpers: Some(false).into(),
                        target: Some(EsVersion::latest()),
                        loose: Some(false).into(),
                        keep_class_names: Some(false).into(),
                        ..Default::default()
                    },
                    module: None,
                    minify: Some(false).into(),
                    source_maps: None,
                    ..Default::default()
                },
                is_module: IsModule::Bool(true),
                ..Default::default()
            },
            &source_file.name,
            None,
            |_| noop(),
        )
        .map_err(|err| {
            let errors = collect_errors(&error_buffer, source_map);
            let reason = if errors.len() > 0 {
                errors
            } else {
                vec![format!("{}", err.to_string())]
            };

            ParserError::new(reason, source_file.name.to_string())
        })?
        .unwrap();

    match result.program {
        Program::Module(m) => Result::Ok(m),
        _ => Result::Err(ParserError::new(
            vec![format!("Script is not expected: {}", &source_file.name)],
            source_file.name.to_string(),
        )),
    }
}

impl TryFrom<&str> for Module {
    type Error = ParserError;

    fn try_from(src: &str) -> Result<Self, Self::Error> {
        Module::new_from_code(
            src,
            &String::from("snippet.ts"),
            ModuleType::Local,
            &String::from("dummy"),
        )
    }
}

impl Module {
    pub fn new_from_code(
        src: &str,
        name: &str,
        mtype: ModuleType,
        pkg_name: &str,
    ) -> Result<Self, ParserError> {
        let file_path = RelativePathBuf::from(name);
        let source_map = Lrc::<SourceMap>::default();
        let source_file =
            source_map.new_source_file(FileName::Real(file_path.to_path("")), src.to_string());

        let swc_module = parse_module(&source_map, &source_file)?;
        let id = ModuleId::new(&file_path, mtype, pkg_name);
        let mut inspector = Inspector::new(
            id.clone(),
            Rc::new(ModuleResolver::empty()),
            Arc::from(source_map.clone()),
        );

        inspector.inspect(&swc_module);

        let exports = inspector.collect_exports();
        let declarations = inspector.collect_declarations();
        let scopes = inspector.collect_scopes();

        Result::Ok(Module {
            source_path: file_path,
            id,
            created_at: None,
            updated_at: None,
            body: swc_module.body,
            exports,
            declarations,
            scopes,
            source_map: Arc::from(source_map),
        })
    }

    pub fn new(
        file_path: &RelativePath,
        project_root: &Path,
        module_resolver: &Rc<ModuleResolver>,
    ) -> Result<Self, ParserError> {
        debug!("Parsing file at {}", &file_path.to_string());

        let source_map = Lrc::<SourceMap>::default();
        let source_file = source_map
            .load_file(&file_path.to_path(project_root))
            .map_err(|err| ParserError::new(vec![err.to_string()], file_path.to_string()))?;
        let swc_module = parse_module(&source_map, &source_file)?;

        let module_path = file_path.to_relative_path_buf();

        let id = module_resolver.get_module_id(module_path.as_str());
        let mut inspector = Inspector::new(
            id.clone(),
            module_resolver.clone(),
            Arc::from(source_map.clone()),
        );

        inspector.inspect(&swc_module);

        let exports = inspector.collect_exports();
        let declarations = inspector.collect_declarations();
        let scopes = inspector.collect_scopes();
        Result::Ok(Module {
            source_path: module_path,
            id,
            created_at: None,
            updated_at: None,
            body: swc_module.body,
            exports,
            declarations,
            scopes,
            source_map: Arc::from(source_map),
        })
    }

    fn get_scope(&self, symbol: &Symbol) -> Option<&Rc<ReferenceScopePtr>> {
        (&self.scopes).iter().find(|s| {
            let scope = s.borrow();

            scope.is_owned_by(symbol)
        })
    }

    pub fn get_html_elements_recursive(
        &self,
        symbol: &Symbol,
        html_elements: &mut Vec<Rc<InferredType>>,
        visited_symbols: &mut AHashSet<Symbol>,
    ) {
        if visited_symbols.contains(symbol) {
            return;
        }

        visited_symbols.insert(symbol.clone());

        debug!("Get HTML elements in {} - {}", symbol, self.id.path);
        let result = self.get_scope(symbol);

        if result.is_none() {
            return;
        }

        let scope = result.unwrap().borrow();

        if let Some(decl) = self.get_declaration(symbol) {
            if let InferredType::ReturnTypeOf(_, _) = &decl.inferred_type.as_ref() {
                for reference in scope.get_references() {
                    self.get_html_elements_recursive(
                        reference.get_symbol(),
                        html_elements,
                        visited_symbols,
                    );
                }
            }
        }

        for jsx_ref in scope.get_references_jsx() {
            if let Some(decl) = self.get_declaration(jsx_ref.get_symbol()) {
                match &decl.inferred_type.as_ref() {
                    InferredType::ReturnTypeOf(_, _)
                    | InferredType::MemberOf(_, _)
                    | InferredType::TypeOf { .. }
                    | InferredType::Union(_)
                    | InferredType::Str(_) => html_elements.push(Rc::clone(&decl.inferred_type)),
                    _ => {}
                }
            } else {
                html_elements.push(Rc::new(InferredType::Str(jsx_ref.get_symbol().get_name())));
            }
        }
    }

    pub fn get_html_elements_in(&self, symbol: &Symbol) -> Vec<Rc<InferredType>> {
        let mut elements = vec![];
        self.get_html_elements_recursive(symbol, &mut elements, &mut AHashSet::new());

        return elements;
    }

    pub fn get_all_references_in(&self, symbol: &Symbol) -> AHashSet<Reference> {
        let result = self.get_scope(symbol);

        let mut refs = AHashSet::new();

        if result.is_none() {
            return refs;
        }

        let scope = result.unwrap().borrow();

        refs.extend(scope.get_references().clone());

        refs.extend(scope.get_references_jsx().clone());

        refs
    }

    pub fn get_usage_map(&self, symbol: &Symbol) -> AHashMap<Reference, AHashSet<Usage>> {
        let result = self.get_scope(symbol);
        result.map_or(AHashMap::new(), |scope| {
            scope.borrow().get_usage_map().clone()
        })
    }

    pub fn get_exports(&self) -> &Vec<Rc<ModuleExport>> {
        &self.exports
    }

    pub fn get_declaration(&self, symbol: &Symbol) -> Option<Rc<Declaration>> {
        (&self.declarations).iter().find_map(|decl| {
            if &decl.symbol == symbol {
                Some(Rc::clone(decl))
            } else {
                None
            }
        })
    }

    pub fn get_inferred_type(&self, reference: &Reference) -> Rc<InferredType> {
        self.get_declaration(reference.get_symbol()).map_or_else(
            || Rc::new(InferredType::Unknown),
            |declaration| {
                if reference.has_member_property() {
                    InferredType::merge_with_member_properties(
                        Rc::clone(&declaration.inferred_type),
                        &mut reference.get_member_properties().clone(),
                    )
                } else {
                    Rc::clone(&declaration.inferred_type)
                }
            },
        )
    }

    pub fn resolve_reference(&self, reference: &Reference) -> ReferenceWithSource {
        InferredType::to_reference_with_source(&self.get_inferred_type(reference)).map_or_else(
            || ReferenceWithSource::new(reference.clone(), self.id.clone()),
            |(r, is_local)| {
                if is_local {
                    self.resolve_reference(&r.reference)
                } else {
                    r.clone()
                }
            },
        )
    }

    pub fn get_prop_definitions(&self, reference: &Reference) -> AHashMap<String, PropDefinition> {
        if reference.has_member_property() {
            AHashMap::new()
        } else {
            self.get_declaration(reference.get_symbol()).map_or_else(
                || AHashMap::new(),
                |declaration| {
                    PropDefinitionFinder::find_prop_definitions(
                        &declaration.definition,
                        &self.source_map,
                    )
                },
            )
        }
    }

    pub fn get_jsx_references(&self) -> AHashSet<Reference> {
        let mut references = AHashSet::new();

        for sp in &self.scopes {
            let scope = sp.borrow();

            references.extend(scope.get_references_jsx().clone());
        }

        references
    }

    pub fn get_export_by_name(&self, name: &str) -> Option<&Rc<ModuleExport>> {
        trace!("Find exported symbol {} in {}", name, self.id.path);

        self.exports.iter().find(|e| e.exported_name == name)
    }

    pub fn get_wildcard_exported_modules(&self) -> Vec<&ModuleId> {
        let wildcard_symbol = Symbol::wildcard();
        (&self.exports)
            .iter()
            .filter(|e| wildcard_symbol.eq_name(&e.exported_name))
            .filter_map(|e| match &e.source {
                ExportSource::External(symbol_with_source) => Some(&symbol_with_source.source),
                ExportSource::Internal(_) => None,
            })
            .collect()
    }

    pub fn get_namespace_export_target(&self, name: &str) -> Option<&ModuleId> {
        let export = self.exports.iter().find(|e| e.exported_name == name)?;
        let symbol = match &export.source {
            ExportSource::Internal(s) => s,
            _ => return None,
        };
        let decl = self.declarations.iter().find(|d| &d.symbol == symbol)?;
        match &decl.definition {
            Definition::ExternalSymbol(sym_with_src) if sym_with_src.symbol.is_wildcard() => {
                Some(&sym_with_src.source)
            }
            _ => None,
        }
    }
}
