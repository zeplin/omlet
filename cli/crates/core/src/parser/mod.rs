use std::{fmt, path::Path, rc::Rc};

use ahash::{AHashMap, AHashSet};
use logger::{debug, trace};
use relative_path::{RelativePath, RelativePathBuf};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use swc_common::{
    errors::{Diagnostic, DiagnosticBuilder, Emitter, Handler, HandlerFlags},
    sync::Lrc,
    FileName, Globals, Mark, SourceFile, SourceMap, GLOBALS,
};
use swc_ecma_ast::{EsVersion, Module as SwcModule, ModuleItem};
use swc_ecma_parser::{parse_file_as_module, Syntax, TsSyntax};
use swc_ecma_transforms_base::resolver;
use swc_ecma_visit::VisitMutWith;

mod inspector;
pub mod symbol;

pub use inspector::{
    CharacterPosition, Definition, ExportSource, InferredType, ModuleExport, ObjectPropValue,
    PropDefinition, PropUsage, PropValue, Reference, ReferenceWithSource, SymbolWithSource, Usage,
};

use inspector::{Declaration, Inspector, PropDefinitionFinder, ReferenceScopePtr};
pub use symbol::Symbol;

use crate::module_resolver::{ModuleId, ModuleResolver, ModuleType};

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
    fn emit(&mut self, db: &mut DiagnosticBuilder<'_>) {
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

// swc's `Config::adjust` used to override these from the file extension
// before handing the config to the parser.
fn syntax_for(file_name: &FileName) -> Syntax {
    let mut config = TsSyntax {
        tsx: true,
        decorators: true,
        ..Default::default()
    };

    if let FileName::Real(path) = file_name {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".d.ts"))
        {
            config.dts = true;
        }

        match path.extension().and_then(|ext| ext.to_str()) {
            Some("tsx") => config.tsx = true,
            Some("ts") => config.tsx = false,
            _ => {}
        }
    }

    Syntax::Typescript(config)
}

pub fn parse_module(
    source_map: &Lrc<SourceMap>,
    source_file: &Lrc<SourceFile>,
) -> Result<SwcModule, ParserError> {
    // `Mark::new` needs a GLOBALS scope; a fresh one per file keeps the syntax
    // contexts module-local and deterministic, as swc's `Compiler` did.
    GLOBALS.set(&Globals::default(), || {
        let error_buffer = ErrorEmitter::default();
        let handler = Handler::with_emitter_and_flags(
            Box::new(error_buffer.clone()),
            HandlerFlags {
                treat_err_as_bug: false,
                can_emit_warnings: true,
                dont_buffer_diagnostics: true,
                ..HandlerFlags::default()
            },
        );

        let syntax = syntax_for(&source_file.name);

        let mut recovered_errors = vec![];
        let result = parse_file_as_module(
            source_file,
            syntax,
            EsVersion::latest(),
            None,
            &mut recovered_errors,
        );

        // A recovered error still aborts the parse: the resulting AST would be wrong.
        let mut failed = !recovered_errors.is_empty();
        for error in recovered_errors {
            error.into_diagnostic(&handler).emit();
        }

        let module = match result {
            Ok(module) => Some(module),
            Err(error) => {
                error.into_diagnostic(&handler).emit();
                failed = true;

                None
            }
        };

        match module {
            Some(mut module) if !failed => {
                let unresolved_mark = Mark::new();
                let top_level_mark = Mark::new();
                module.visit_mut_with(&mut resolver(unresolved_mark, top_level_mark, true));

                Result::Ok(module)
            }
            _ => {
                let errors = collect_errors(&error_buffer, source_map);
                let reason = if errors.len() > 0 {
                    errors
                } else {
                    vec![String::from("Syntax Error")]
                };

                Result::Err(ParserError::new(reason, source_file.name.to_string()))
            }
        }
    })
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
        let source_file = source_map.new_source_file(
            Lrc::new(FileName::Real(file_path.to_path(""))),
            src.to_string(),
        );

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
}
