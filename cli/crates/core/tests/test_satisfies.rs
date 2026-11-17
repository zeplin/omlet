use std::cell::RefCell;
use std::collections::BTreeSet;
use std::{path::PathBuf, rc::Rc};

use omlet::analyzer::Analyzer;
use omlet::module_resolver::ModuleResolver;
use omlet::parser::Module;
use relative_path::RelativePathBuf;
use utils::{get_project_root, glob, list_all_project_files};

struct ScanResult {
    failed_modules: Vec<String>,
    component_names: BTreeSet<String>,
    dependencies_of_app: BTreeSet<String>,
    dependencies_of_page: BTreeSet<String>,
    props_of_aliased: BTreeSet<String>,
}

fn scan_satisfies_sample() -> ScanResult {
    let project_root = get_project_root(&PathBuf::from("../../samples/satisfies")).unwrap();
    let include_patterns = vec![String::from("src/**/*.{js,jsx,ts,tsx}")];
    let input_files: Vec<RelativePathBuf> = glob(&project_root, &include_patterns, &vec![])
        .unwrap()
        .collect();
    let module_resolver = Rc::new(ModuleResolver::empty());

    let mut modules: Vec<Rc<RefCell<Module>>> = vec![];
    let mut failed_modules = vec![];

    for module_path in list_all_project_files(&project_root).unwrap() {
        match Module::new(&module_path, &project_root, &module_resolver) {
            Ok(module) => modules.push(Rc::new(RefCell::new(module))),
            Err(error) => failed_modules.push(format!("{}: {}", module_path, error)),
        }
    }

    let mut analyzer = Analyzer::new(&modules, &module_resolver, input_files, true).unwrap();
    let result = analyzer.analyze();

    let component = |name: &str| result.components.iter().find(|c| c.name == name);
    let dependency_names = |name: &str| {
        component(name)
            .map(|c| c.dependencies.iter().map(|d| d.to.name.clone()).collect())
            .unwrap_or_default()
    };

    ScanResult {
        failed_modules,
        component_names: result.components.iter().map(|c| c.name.clone()).collect(),
        dependencies_of_app: dependency_names("App"),
        dependencies_of_page: dependency_names("Page"),
        props_of_aliased: component("Aliased")
            .map(|c| c.props.keys().cloned().collect())
            .unwrap_or_default(),
    }
}

#[test]
fn test_satisfies_operator_does_not_drop_components() {
    let ScanResult {
        failed_modules,
        component_names,
        dependencies_of_app,
        dependencies_of_page,
        props_of_aliased,
    } = scan_satisfies_sample();

    assert_eq!(
        failed_modules,
        Vec::<String>::new(),
        "every module in samples/satisfies must parse"
    );

    assert_eq!(
        component_names,
        BTreeSet::from([
            String::from("Aliased"),
            String::from("App"),
            String::from("Broken"),
            String::from("Broken2"),
            String::from("List"),
            String::from("Ok"),
            String::from("Page"),
            String::from("Theme"),
        ])
    );

    assert_eq!(
        dependencies_of_app,
        BTreeSet::from([
            String::from("Broken"),
            String::from("Broken2"),
            String::from("Ok"),
        ]),
        "usages of components declared in a module using satisfies must still be collected"
    );

    assert_eq!(
        dependencies_of_page,
        BTreeSet::from([String::from("Aliased")]),
        "a component aliased through satisfies must still resolve to one component"
    );

    assert_eq!(
        props_of_aliased,
        BTreeSet::from([String::from("title")]),
        "satisfies must be unwrapped so the alias traces back to the wrapped declaration"
    );
}
