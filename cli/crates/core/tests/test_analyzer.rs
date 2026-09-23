use derivative::Derivative;
use relative_path::RelativePathBuf;
use std::cell::RefCell;
use std::fs;
use std::{ops::Deref, path::PathBuf, rc::Rc};

use omlet::analyzer::{AnalyzerResult, Component, Dependency, DependencyDatum, Export};
use omlet::parser::{
    symbol::MemberProperty, CharacterPosition, InferredType, Module, PropUsage,
    ReferenceWithSource, SymbolWithSource, Usage,
};
use omlet::{analyzer::Analyzer, module_resolver::ModuleResolver};
use serde::Serialize;

use utils::{get_project_root, glob, list_all_project_files};

fn source_to_string(source: &SymbolWithSource) -> String {
    format!(
        "{}:{}:{}",
        source.source.pkg_name,
        source.source.get_path_hash(),
        source.get_name()
    )
}
fn reference_with_source_to_string(reference_with_source: &ReferenceWithSource) -> String {
    format!(
        "{}:{}:{}",
        reference_with_source.source.pkg_name,
        reference_with_source.source.get_path_hash(),
        reference_with_source.get_name()
    )
}

fn member_property_to_string(member_property: &MemberProperty) -> String {
    match member_property {
        MemberProperty::Array(idx) => format!("{}", idx),
        MemberProperty::Object(prop) => prop.to_string(),
        MemberProperty::Invalid => String::from("invalid"),
    }
}

fn inferred_type_to_string(value: &Rc<InferredType>) -> String {
    match value.deref() {
        InferredType::ReturnTypeOf(func, _) => {
            format!("ReturnTypeOf<{}>", inferred_type_to_string(func))
        }
        InferredType::TypeOf { symbol, .. } => format!("TypeOf<{}>", source_to_string(symbol),),
        InferredType::ParameterOf { function, index } => {
            format!("ParameterOf<{}>[{}]", source_to_string(function), index)
        }
        InferredType::Union(types) => format!(
            "Union<{}>",
            types
                .iter()
                .map(inferred_type_to_string)
                .collect::<Vec<String>>()
                .join(" | ")
        ),
        InferredType::Unknown => String::from("Unknown"),
        InferredType::JSX => String::from("JSX"),
        InferredType::Class(super_cls) => {
            format!("Class<extends {}>", inferred_type_to_string(super_cls))
        }
        InferredType::Function(return_types) => format!(
            "(Function -> {})",
            return_types
                .iter()
                .map(inferred_type_to_string)
                .collect::<Vec<String>>()
                .join(" | ")
        ),
        InferredType::MemberOf(obj, member_property) => format!(
            "{}[{}]",
            inferred_type_to_string(obj),
            member_property_to_string(member_property)
        ),
        InferredType::Object(obj_map) => {
            let mut obj_content = obj_map
                .iter()
                .map(|(k, t)| format!("{}: {}", k, inferred_type_to_string(t)))
                .collect::<Vec<String>>();

            obj_content.sort();

            format!("{{ {} }}", obj_content.join(", "))
        }
        InferredType::Array(types) => format!(
            "Array<{}>",
            types
                .iter()
                .map(inferred_type_to_string)
                .collect::<Vec<String>>()
                .join(" | ")
        ),
        InferredType::Str(value) => format!("String<{}>", value),
    }
}

#[derive(Serialize, PartialEq, PartialOrd, Ord, Eq)]
struct RedactedProp {
    name: String,
    default_value: String,
}

#[derive(Serialize, PartialEq, PartialOrd, Ord, Eq)]
struct RedactedPropUsage {
    name: String,
    value: String,
}
impl From<&PropUsage> for RedactedPropUsage {
    fn from(value: &PropUsage) -> Self {
        Self {
            name: value.name.clone(),
            value: format!("{:?}", value.value),
        }
    }
}

#[derive(Serialize, Derivative)]
#[derivative(PartialEq, PartialOrd, Ord, Eq)]
struct RedactedUsage {
    start: CharacterPosition,
    end: CharacterPosition,
    props: Vec<RedactedPropUsage>,
}

impl From<&Usage> for RedactedUsage {
    fn from(value: &Usage) -> Self {
        let mut props: Vec<RedactedPropUsage> = value.props.iter().map(|p| p.into()).collect();
        props.sort();

        Self {
            start: value.start.clone(),
            end: value.end.clone(),
            props,
        }
    }
}

#[derive(Serialize, Derivative)]
#[derivative(PartialEq, PartialOrd, Ord, Eq)]
struct RedactedReference {
    trace: Vec<String>,
    usages: Vec<RedactedUsage>,
}
impl From<&DependencyDatum> for RedactedReference {
    fn from(value: &DependencyDatum) -> Self {
        let mut usages: Vec<RedactedUsage> = value.usages.iter().map(|v| v.into()).collect();
        usages.sort();
        Self {
            trace: value
                .trace
                .iter()
                .map(|v| reference_with_source_to_string(v))
                .collect(),
            usages,
        }
    }
}

#[derive(Serialize, Derivative)]
#[derivative(PartialEq, PartialOrd, Ord, Eq)]
struct RedactedDependency {
    from: String,
    to: String,
    references: Vec<RedactedReference>,
}
impl From<&Dependency> for RedactedDependency {
    fn from(value: &Dependency) -> Self {
        let mut references: Vec<RedactedReference> =
            value.references.iter().map(|v| v.into()).collect();
        references.sort();

        Self {
            from: source_to_string(&value.from.source),
            to: source_to_string(&value.to.source),
            references,
        }
    }
}

#[derive(Serialize, Derivative)]
#[derivative(PartialEq, PartialOrd, Ord, Eq)]
struct RedactedComponent {
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    definition_id: String,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    name: String,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    export_ids: Vec<String>,
    package_name: String,
    source_path: String,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    dependencies: Vec<RedactedDependency>,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    props: Vec<RedactedProp>,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    html_elements: Vec<String>,
}

impl From<&Component> for RedactedComponent {
    fn from(component: &Component) -> Self {
        let mut export_ids = component
            .export_ids
            .iter()
            .map(|eid| format!("{:?}", eid))
            .collect::<Vec<String>>();
        export_ids.sort();

        let mut dependencies: Vec<RedactedDependency> =
            component.dependencies.iter().map(|d| d.into()).collect();
        dependencies.sort();

        let mut props: Vec<RedactedProp> = component
            .props
            .iter()
            .map(|(_, prop)| RedactedProp {
                name: prop.name.to_string(),
                default_value: prop
                    .default_value
                    .as_ref()
                    .map(|v| format!("{:?}", v))
                    .unwrap_or("NONE".to_string()),
            })
            .collect();
        props.sort();

        let mut html_elements: Vec<String> =
            component.html_elements.iter().map(|s| s.clone()).collect();
        html_elements.sort();

        Self {
            definition_id: component.id.clone(),
            name: component.name.clone(),
            export_ids,
            package_name: component.source.source.pkg_name.clone(),
            source_path: component.source.source.path.clone().into_string(),
            dependencies,
            props,
            html_elements,
        }
    }
}

#[derive(Serialize, Derivative)]
#[derivative(PartialEq, PartialOrd, Ord, Eq)]
struct RedactedExport {
    name: String,
    source_path: String,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    is_component: bool,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    inferred_type: String,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    resolved_type: String,
    #[derivative(PartialEq = "ignore", PartialOrd = "ignore", Ord = "ignore")]
    trace_to_declaration: Vec<String>,
}

impl From<&Export> for RedactedExport {
    fn from(export: &Export) -> Self {
        Self {
            name: export.name.clone(),
            source_path: export.module_id.path.clone().into_string(),
            is_component: export.is_component,
            trace_to_declaration: export
                .trace_to_declaration
                .iter()
                .map(reference_with_source_to_string)
                .collect(),
            inferred_type: inferred_type_to_string(&export.inferred_type),
            resolved_type: inferred_type_to_string(&export.resolved_type),
        }
    }
}

#[derive(Serialize)]
struct ExportResults {
    num_of_exports: usize,
    exports: Vec<RedactedExport>,
}

#[derive(Serialize)]
struct ComponentResults {
    num_of_components: usize,
    components: Vec<RedactedComponent>,
}

#[derive(Serialize)]
struct AnalyzerTestResult {
    component_results: ComponentResults,
    export_results: ExportResults,
}

impl From<AnalyzerResult> for AnalyzerTestResult {
    fn from(result: AnalyzerResult) -> Self {
        let mut components: Vec<RedactedComponent> =
            result.components.iter().map(|c| c.into()).collect();
        components.sort();

        let mut exports: Vec<RedactedExport> = result.exports.iter().map(|c| c.into()).collect();
        exports.sort();

        Self {
            component_results: ComponentResults {
                num_of_components: result.components.len(),
                components,
            },
            export_results: ExportResults {
                num_of_exports: result.exports.len(),
                exports,
            },
        }
    }
}

fn run_analyzer(
    project_root: &PathBuf,
    include_patterns: &Vec<String>,
    alias_map_path: Option<String>,
    ignore_patterns: &Vec<String>,
) -> AnalyzerTestResult {
    let mut modules: Vec<Rc<RefCell<Module>>> = vec![];
    let input_files: Vec<RelativePathBuf> = glob(project_root, include_patterns, ignore_patterns)
        .unwrap()
        .collect();
    let all_files: Vec<RelativePathBuf> = list_all_project_files(&project_root).unwrap().collect();
    let module_resolver = if let Some(path) = alias_map_path {
        let project_setup_str = &fs::read_to_string(PathBuf::from(path)).unwrap();
        let project_setup = serde_json::from_str(project_setup_str).unwrap();
        Rc::new(ModuleResolver::new(project_setup, &all_files))
    } else {
        Rc::new(ModuleResolver::empty())
    };

    for module_path in all_files {
        modules.push(Rc::new(RefCell::new(
            Module::new(&module_path, project_root, &module_resolver).unwrap(),
        )));
    }

    let mut analyzer = Analyzer::new(&modules, &module_resolver, input_files, true).unwrap();
    analyzer.analyze().into()
}

#[test]
fn test_analyze_yarn_monorepo() {
    let glob_pattern = vec![String::from("packages/**/*.{js,jsx,ts,tsx}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/monorepos/yarn-ts")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/yarn-ts/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        // See samples/monorepos/yarn-ts/.omletrc.json file
        &vec![String::from("packages/ignored-package/**/*")],
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_npm_monorepo() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/monorepos/npm-ts")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/npm-ts/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_typescript_paths() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root =
        get_project_root(&PathBuf::from("../../samples/monorepos/ts-paths")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/ts-paths/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_pnpm_monorepo() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/monorepos/pnpm-ts")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/pnpm-ts/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_lerna_monorepo() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root =
        get_project_root(&PathBuf::from("../../samples/monorepos/lerna-ts")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/lerna-ts/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_pnpm_monorepo_with_tspaths() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root =
        get_project_root(&PathBuf::from("../../samples/monorepos/pnpm-ts-paths")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/pnpm-ts-paths/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_monorepo_with_nested_packages() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root =
        get_project_root(&PathBuf::from("../../samples/monorepos/nested-packages")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/nested-packages/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_nx_monorepo() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root =
        get_project_root(&PathBuf::from("../../samples/monorepos/nx-react-monorepo")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/monorepos/nx-react-monorepo/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `multi-project/<project>/*`
#[test]
fn test_analyze_multi_project() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];

    let project_root_design_system = get_project_root(&PathBuf::from(
        "../../samples/multi-project/acme-design-system",
    ))
    .unwrap();
    let alias_map_path_design_system = Some(String::from(
        "../../samples/multi-project/acme-design-system/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results: component_results_design_system,
        export_results: export_results_design_system,
    } = run_analyzer(
        &project_root_design_system,
        &glob_pattern,
        alias_map_path_design_system,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results_design_system);
    snap::assert_yaml_snapshot!(&export_results_design_system);

    let project_root_webapp =
        get_project_root(&PathBuf::from("../../samples/multi-project/acme-webapp")).unwrap();
    let alias_map_path_webapp = Some(String::from(
        "../../samples/multi-project/acme-webapp/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results: component_results_webapp,
        export_results: export_results_webapp,
    } = run_analyzer(
        &project_root_webapp,
        &glob_pattern,
        alias_map_path_webapp,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results_webapp);
    snap::assert_yaml_snapshot!(&export_results_webapp);
}

#[test]
fn test_analyze_custom_alias() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let ignore_pattern = vec![String::from("src/ignored-components/*.{js,jsx,ts,tsx}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/custom-alias")).unwrap();
    let alias_map_path = Some(String::from("../../samples/custom-alias/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &ignore_pattern,
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_color_exports() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let ignore_pattern = vec![String::from("src/*.{js,jsx,ts,tsx}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/color")).unwrap();
    let alias_map_path = Some(String::from("../../samples/color/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &ignore_pattern,
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

#[test]
fn test_analyze_overridden_custom_alias() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];
    let project_root =
        get_project_root(&PathBuf::from("../../samples/overridden-custom-alias")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/overridden-custom-alias/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/*`
#[test]
fn test_analyze_typescript_root() {
    let glob_pattern = vec![String::from("src/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/subcomponent/**/*`
#[test]
fn test_analyze_typescript_subcomponent() {
    let glob_pattern = vec![String::from("src/subcomponent/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/class-component/**/*`
#[test]
fn test_analyze_typescript_class_components() {
    let glob_pattern = vec![String::from("src/class-component/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/forwardRef/**/*`
#[test]
fn test_analyze_typescript_forwardref() {
    let glob_pattern = vec![String::from("src/forwardRef/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/functional-component/**/*`
#[test]
fn test_analyze_typescript_functional_components() {
    let glob_pattern = vec![String::from("src/functional-component/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/hess/**/*`
#[test]
fn test_analyze_typescript_hess() {
    let glob_pattern = vec![String::from("src/hess/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/memo/**/*`
#[test]
fn test_analyze_typescript_memo() {
    let glob_pattern = vec![String::from("src/memo/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/module-decls/**/*`
#[test]
fn test_analyze_typescript_module_decls() {
    let glob_pattern = vec![String::from("src/module-decls/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/multiple-exports/**/*`
#[test]
fn test_analyze_typescript_multiple_exports() {
    let glob_pattern = vec![String::from("src/multiple-exports/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/simple/**/*`
#[test]
fn test_analyze_typescript_simple() {
    let glob_pattern = vec![String::from("src/simple/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/wrapped-components/**/*`
#[test]
fn test_analyze_typescript_wrapped_components() {
    let glob_pattern = vec![String::from("src/wrapped-components/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/styled-component/**/*`
#[test]
fn test_analyze_typescript_styled_component() {
    let glob_pattern = vec![String::from("src/styled-component/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/web-component/**/*`
#[test]
fn test_analyze_typescript_web_component() {
    let glob_pattern = vec![String::from("src/web-component/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/jsx-refs/**/*`
#[test]
fn test_analyze_typescript_jsx_refs() {
    let glob_pattern = vec![String::from("src/jsx-refs/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/indirect-deps/**/*`
#[test]
fn test_analyze_typescript_indirect_deps() {
    let glob_pattern = vec![String::from("src/indirect-deps/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/renamed-import/**/*`
#[test]
fn test_analyze_typescript_renamed_import() {
    let glob_pattern = vec![String::from("src/renamed-import/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/redeclare-import/**/*`
#[test]
fn test_analyze_typescript_redeclare_import() {
    let glob_pattern = vec![String::from("src/redeclare-import/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/absolute-import/**/*`
#[test]
fn test_analyze_typescript_absolute_import() {
    let glob_pattern = vec![String::from("src/absolute-import/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/wildcard-import/**/*`
#[test]
fn test_analyze_typescript_wildcard_import() {
    let glob_pattern = vec![String::from("src/wildcard-import/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/wildcard-re-export/**/*`
#[test]
fn test_analyze_typescript_wildcard_re_export() {
    let glob_pattern = vec![String::from("src/wildcard-re-export/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/namespace-re-export/**/*`
#[test]
fn test_analyze_typescript_namespace_re_export() {
    let glob_pattern = vec![String::from("src/namespace-re-export/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/component-assign-propagation/**/*`
#[test]
fn test_analyze_typescript_component_assign_propagation() {
    let glob_pattern = vec![String::from("src/component-assign-propagation/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/dynamic-import/**/*`
#[test]
fn test_analyze_typescript_dynamic_import() {
    let glob_pattern = vec![String::from("src/dynamic-import/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `props/**/*`
#[test]
fn test_analyze_props() {
    let glob_pattern = vec![String::from("src/**/*.{tsx,jsx}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/props")).unwrap();
    let alias_map_path = Some(String::from("../../samples/props/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `wildcard-exports/design-system`
#[test]
fn test_analyze_wildcard_export_design_system() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];

    let project_root = get_project_root(&PathBuf::from(
        "../../samples/wildcard-exports/design-system",
    ))
    .unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/wildcard-exports/design-system/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `wildcard-exports/webapp`
#[test]
fn test_analyze_wildcard_export_webapp() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];

    let project_root =
        get_project_root(&PathBuf::from("../../samples/wildcard-exports/webapp")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/wildcard-exports/webapp/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `npm-dependency-alias`
#[test]
fn test_analyze_npm_dependency_alias() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];

    let project_root =
        get_project_root(&PathBuf::from("../../samples/npm-dependency-alias")).unwrap();
    let alias_map_path = Some(String::from(
        "../../samples/npm-dependency-alias/alias-map.json",
    ));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `custom-export`
#[test]
fn test_analyze_custom_export() {
    let glob_pattern = vec![String::from("**/*.{js,jsx,ts,tsx}")];

    let project_root = get_project_root(&PathBuf::from("../../samples/custom-export")).unwrap();
    let alias_map_path = Some(String::from("../../samples/custom-export/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}

// Analysis of files `typescript/src/object-properties/**/*`
#[test]
fn test_analyze_typescript_object_properties() {
    let glob_pattern = vec![String::from("src/object-properties/**/*.{tsx,ts}")];
    let project_root = get_project_root(&PathBuf::from("../../samples/typescript")).unwrap();
    let alias_map_path = Some(String::from("../../samples/typescript/alias-map.json"));

    let AnalyzerTestResult {
        component_results,
        export_results,
    } = run_analyzer(
        &project_root,
        &glob_pattern,
        alias_map_path,
        &Vec::<String>::new(),
    );

    snap::assert_yaml_snapshot!(&component_results);
    snap::assert_yaml_snapshot!(&export_results);
}
