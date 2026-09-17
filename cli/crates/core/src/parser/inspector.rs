use std::collections::BTreeMap;
use std::fmt::Display;
use std::{
    cell::RefCell,
    cmp::Ordering,
    fmt,
    hash::Hash,
    ops::Deref,
    rc::{Rc, Weak},
    sync::Arc,
};

use ahash::{AHashMap, AHashSet};
use derivative::Derivative;
use serde::{ser::SerializeStruct, Serialize, Serializer};
use swc_atoms::Atom;
use swc_common::{Loc, SourceMap, Span};
use swc_ecma_ast::{
    ArrayLit, ArrowExpr, ArrowFunctionBody, CallExpr, Callee, Class, ClassDecl, ClassExpr,
    CondExpr, Decl, DefaultDecl, ExportAll, ExportDecl, ExportDefaultDecl, ExportDefaultExpr,
    ExportSpecifier, Expr, FnDecl, FnExpr, Function, FunctionBody, Ident, ImportDecl,
    ImportSpecifier, JSXAttrName, JSXAttrOrSpread, JSXAttrValue, JSXElement, JSXElementName,
    JSXExpr, JSXMemberExpr, JSXObject, Lit, MemberExpr, MemberProp, Module as SwcModule,
    ModuleDecl, NamedExport, ObjectLit, ObjectPat as ObjectPattern,
    ObjectPatProp as ObjectPatternProp, OptChainBase, Param, Pat as EsPattern, Prop, PropName,
    PropOrSpread, ReturnStmt, Stmt, SuperProp, TaggedTpl, VarDeclarator,
};
use swc_ecma_ast::{AssignExpr, AssignOp, BinExpr, SimpleAssignTarget};
use swc_ecma_visit::{Visit, VisitWith};

use crate::module_resolver::{ModuleId, ModuleResolver};

use super::symbol::{MemberProperty, Symbol};

#[derive(Serialize, PartialOrd, Ord, PartialEq, Eq, Hash, Debug, Clone)]
pub struct CharacterPosition {
    pub line: usize,
    pub column: usize,
}

impl CharacterPosition {
    pub fn from_loc(loc: &Loc) -> Self {
        Self {
            line: loc.line,
            // Loc uses 1-based indexing for line but 0-based indexing for column.
            // Increment column by 1 to make it 1-based
            column: loc.col_display + 1,
        }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ObjectPropValue {
    Spread { value: Box<PropValue> },

    Shorthand { key: String },

    KeyValue { key: String, value: Box<PropValue> },
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum PropValue {
    String {
        value: String,
    },
    Number {
        value: f64,
    },
    Identifier {
        value: String,
    },
    Bool {
        value: bool,
    },
    Regex {
        value: String,
        flags: String,
    },
    Array {
        values: Vec<PropValue>,
    },
    Spread {
        value: Box<PropValue>,
    },
    Member {
        value: Box<PropValue>,
        property: Box<PropValue>,
    },
    Null,
    JSXElement,
    Function,
    Getter,
    Setter,
    Object {
        props: Vec<ObjectPropValue>,
    },
    This,
    Super,
    TemplateLiteral,
    Expression,
}

impl PropValue {
    pub fn from_lit(lit: &Lit) -> Option<Self> {
        match lit {
            Lit::Str(value) => Some(Self::String {
                value: value.value.to_string_lossy().into_owned(),
            }),
            Lit::Num(value) => Some(Self::Number { value: value.value }),
            Lit::Bool(value) => Some(Self::Bool { value: value.value }),
            Lit::Null(_) => Some(Self::Null),
            Lit::Regex(value) => Some(Self::Regex {
                value: value.exp.to_string(),
                flags: value.flags.to_string(),
            }),
            _ => None,
        }
    }
    pub fn from_expr(expr: &Expr) -> Option<Self> {
        match expr {
            Expr::Ident(ident) => Some(Self::Identifier {
                value: ident.sym.to_string(),
            }),
            Expr::Lit(lit) => Self::from_lit(lit),
            Expr::JSXElement(_) => Some(Self::JSXElement),
            Expr::JSXFragment(_) => Some(Self::JSXElement),
            Expr::Fn(_) => Some(Self::Function),
            Expr::Arrow(_) => Some(Self::Function),
            Expr::Array(value) => Some(Self::Array {
                values: value
                    .elems
                    .iter()
                    .map(|elem| -> Option<Self> {
                        if let Some(val) = elem {
                            if val.spread.is_some() {
                                Some(Self::Spread {
                                    value: Box::new(Self::from_expr(val.expr.as_ref())?),
                                })
                            } else {
                                Some(Self::from_expr(val.expr.as_ref())?)
                            }
                        } else {
                            None
                        }
                    })
                    .flatten()
                    .collect(),
            }),
            Expr::Object(object) => Some(Self::Object {
                props: object
                    .props
                    .iter()
                    .filter_map(|prop_or_spread| {
                        match prop_or_spread {
                            // Handle the spread case, i.e., { ...otherObj }
                            PropOrSpread::Spread(spread) => Some(ObjectPropValue::Spread {
                                value: Box::new(Self::from_expr(spread.expr.as_ref())?), // Handle the spread expression
                            }),
                            // Handle the key-value properties, i.e., { key: value }
                            PropOrSpread::Prop(prop) => match &**prop {
                                // Match normal key-value pairs
                                Prop::KeyValue(kv) => match &kv.key {
                                    PropName::Ident(ident) => {
                                        let key = ident.sym.to_string();
                                        let value = Self::from_expr(kv.value.as_ref())?;
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(value),
                                        })
                                    }
                                    PropName::Str(str) => {
                                        let key = str.value.to_string_lossy().into_owned();
                                        let value = Self::from_expr(kv.value.as_ref())?;
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(value),
                                        })
                                    }
                                    _ => None,
                                },
                                // Handle shorthand properties, i.e., { key }
                                Prop::Shorthand(ident) => {
                                    let key = ident.sym.to_string();
                                    Some(ObjectPropValue::Shorthand { key })
                                }
                                // Handle getters
                                Prop::Getter(getter) => match &getter.key {
                                    PropName::Ident(ident) => {
                                        let key = ident.sym.to_string();
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(Self::Getter),
                                        })
                                    }
                                    PropName::Str(str) => {
                                        let key = str.value.to_string_lossy().into_owned();
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(Self::Getter),
                                        })
                                    }
                                    _ => None,
                                },
                                // Handle setters
                                Prop::Setter(setter) => match &setter.key {
                                    PropName::Ident(ident) => {
                                        let key = ident.sym.to_string();
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(Self::Setter),
                                        })
                                    }
                                    PropName::Str(str) => {
                                        let key = str.value.to_string_lossy().into_owned();
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(Self::Setter),
                                        })
                                    }
                                    _ => None,
                                },
                                // Handle methods
                                Prop::Method(method) => match &method.key {
                                    PropName::Ident(ident) => {
                                        let key = ident.sym.to_string();
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(Self::Function),
                                        })
                                    }
                                    PropName::Str(str) => {
                                        let key = str.value.to_string_lossy().into_owned();
                                        Some(ObjectPropValue::KeyValue {
                                            key,
                                            value: Box::new(Self::Function),
                                        })
                                    }
                                    _ => None,
                                },
                                _ => None,
                            },
                        }
                    })
                    .collect(),
            }),
            Expr::Member(member) => match &member.prop {
                MemberProp::Ident(prop) => Some(Self::Member {
                    value: Box::new(Self::from_expr(member.obj.as_ref())?),
                    property: Box::new(Self::String {
                        value: prop.sym.to_string(),
                    }),
                }),
                MemberProp::Computed(prop) => Some(Self::Member {
                    value: Box::new(Self::from_expr(member.obj.as_ref())?),
                    property: Box::new(Self::from_expr(prop.expr.as_ref())?),
                }),
                _ => None,
            },
            Expr::SuperProp(super_prop) => match &super_prop.prop {
                SuperProp::Ident(prop) => Some(Self::Member {
                    value: Box::new(Self::Super),
                    property: Box::new(Self::String {
                        value: prop.sym.to_string(),
                    }),
                }),
                SuperProp::Computed(prop) => Some(Self::Member {
                    value: Box::new(Self::Super),
                    property: Box::new(Self::from_expr(prop.expr.as_ref())?),
                }),
            },
            Expr::OptChain(expr) => match expr.base.as_ref() {
                OptChainBase::Member(expr) => match &expr.prop {
                    MemberProp::Ident(prop) => Some(Self::Member {
                        value: Box::new(Self::from_expr(expr.obj.as_ref())?),
                        property: Box::new(Self::String {
                            value: prop.sym.to_string(),
                        }),
                    }),
                    MemberProp::Computed(prop) => Some(Self::Member {
                        value: Box::new(Self::from_expr(expr.obj.as_ref())?),
                        property: Box::new(Self::from_expr(prop.expr.as_ref())?),
                    }),
                    _ => None,
                },
                OptChainBase::Call(_) => Some(Self::Expression),
            },
            Expr::Paren(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::TsTypeAssertion(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::TsConstAssertion(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::TsNonNull(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::TsAs(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::TsInstantiation(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::TsSatisfies(expr) => Self::from_expr(expr.expr.as_ref()),
            Expr::This(_) => Some(Self::This),
            Expr::Tpl(_) => Some(Self::TemplateLiteral),
            Expr::Invalid(_) => None,
            _ => Some(Self::Expression),
        }
    }

    fn from_jsx_attribute_value(value: &JSXAttrValue) -> Option<Self> {
        match value {
            JSXAttrValue::Str(str) => Some(Self::String {
                value: str.value.to_string_lossy().into_owned(),
            }),
            JSXAttrValue::JSXExprContainer(expr) => match &expr.expr {
                JSXExpr::JSXEmptyExpr(_) => None,
                JSXExpr::Expr(expr) => Self::from_expr(&expr),
            },
            JSXAttrValue::JSXElement(_) => Some(Self::JSXElement),
            JSXAttrValue::JSXFragment(_) => Some(Self::JSXElement),
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct PropUsage {
    pub name: String,
    pub value: PropValue,
}

impl PropUsage {
    fn from_attribute(attribute: &JSXAttrOrSpread) -> Option<Self> {
        match attribute {
            JSXAttrOrSpread::JSXAttr(attribute) => {
                let value = if let Some(val) = &attribute.value {
                    PropValue::from_jsx_attribute_value(val)
                } else {
                    Some(PropValue::Bool { value: true })
                };

                value.and_then(|v| {
                    let name = match &attribute.name {
                        JSXAttrName::Ident(ident) => ident.sym.to_string(),
                        JSXAttrName::JSXNamespacedName(name_spaced) => {
                            format!("{}:{}", name_spaced.ns, name_spaced.name)
                        }
                    };
                    Some(Self { name, value: v })
                })
            }
            JSXAttrOrSpread::SpreadElement(spread) => {
                PropValue::from_expr(&spread.expr).and_then(|v| {
                    Some(Self {
                        name: "".to_string(),
                        value: PropValue::Spread { value: Box::new(v) },
                    })
                })
            }
        }
    }
}

#[derive(Serialize, Debug, Clone, Derivative)]
#[derivative(PartialEq, Eq, Hash)]
pub struct Usage {
    #[derivative(PartialEq = "ignore", Hash = "ignore")]
    pub props: Vec<PropUsage>,
    pub start: CharacterPosition,
    pub end: CharacterPosition,
}

impl Usage {
    pub fn from_jsx_element(element: &JSXElement, source_map: &Arc<SourceMap>) -> Self {
        let mut props: Vec<PropUsage> = element
            .opening
            .attrs
            .iter()
            .filter_map(PropUsage::from_attribute)
            .collect();
        if element.children.len() > 0 {
            props.push(PropUsage {
                name: "children".to_string(),
                value: PropValue::JSXElement,
            })
        }
        Self {
            start: CharacterPosition::from_loc(&source_map.lookup_char_pos(element.span.lo)),
            end: CharacterPosition::from_loc(&source_map.lookup_char_pos(element.span.hi)),
            props,
        }
    }
}

#[derive(Debug, Hash, PartialEq, Eq, Clone, PartialOrd, Ord)]
pub struct Reference {
    symbol: Symbol,
    member_properties: Vec<MemberProperty>,
}

impl Reference {
    pub fn is_wildcard(&self) -> bool {
        self.symbol.is_wildcard()
    }

    pub fn push_member_property(&mut self, member_property: MemberProperty) {
        if self.is_wildcard() {
            self.symbol = member_property.into();
        } else {
            self.member_properties.push(member_property);
        }
    }

    pub fn get_member_properties(&self) -> &Vec<MemberProperty> {
        &self.member_properties
    }

    pub fn has_member_property(&self) -> bool {
        !self.member_properties.is_empty()
    }

    pub fn get_symbol(&self) -> &Symbol {
        &self.symbol
    }

    pub fn get_name(&self) -> String {
        self.symbol.get_name()
    }

    pub fn get_name_with_member_properties(&self) -> String {
        if self.has_member_property() {
            format!(
                "{}.{}",
                self.get_name(),
                self.get_member_properties()
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(".")
            )
        } else {
            self.get_name()
        }
    }

    pub fn get_exported_name_with_member_properties(&self, exported_name: String) -> String {
        format!(
            "{}.{}",
            exported_name,
            self.get_member_properties()
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(".")
        )
    }
}

impl From<Symbol> for Reference {
    fn from(symbol: Symbol) -> Self {
        Self {
            symbol,
            member_properties: vec![],
        }
    }
}

impl From<&JSXMemberExpr> for Reference {
    fn from(jsx_member_expr: &JSXMemberExpr) -> Self {
        let mut inner: Reference = match &jsx_member_expr.obj {
            JSXObject::JSXMemberExpr(inner) => inner.as_ref().into(),
            JSXObject::Ident(ident) => Symbol::from(ident).into(),
        };
        inner
            .member_properties
            .push(MemberProperty::Object(jsx_member_expr.prop.sym.to_string()));
        inner
    }
}

impl Serialize for Reference {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(format!("{}", self).as_str())
    }
}

impl Display for Reference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.symbol)?;
        for member_property in &self.member_properties {
            write!(f, ".{member_property}")?;
        }
        Ok(())
    }
}

pub type ReferenceScopePtr = RefCell<ReferenceScope>;

#[derive(Debug)]
pub struct ReferenceScope {
    owner: Symbol,
    parent: Option<Weak<ReferenceScopePtr>>,
    children: Vec<Rc<ReferenceScopePtr>>,
    references: AHashSet<Reference>,
    // TODO: References should live together so this is a ugly workaround for now
    jsx_references: AHashSet<Reference>,
    usage_map: AHashMap<Reference, AHashSet<Usage>>,
}

const GLOBAL_NAME: &str = "__global";
impl ReferenceScope {
    fn new(owner: &Symbol, parent: &Rc<ReferenceScopePtr>) -> Self {
        Self {
            owner: owner.clone(),
            parent: Some(Rc::downgrade(&Rc::clone(parent))),
            children: vec![],
            references: AHashSet::new(),
            jsx_references: AHashSet::new(),
            usage_map: AHashMap::new(),
        }
    }

    fn global() -> Self {
        Self {
            owner: Symbol::from(GLOBAL_NAME),
            parent: None,
            children: vec![],
            references: AHashSet::new(),
            jsx_references: AHashSet::new(),
            usage_map: AHashMap::new(),
        }
    }

    fn is_global(&self) -> bool {
        self.owner.eq_name(GLOBAL_NAME)
    }

    fn add_child(&mut self, child: Rc<ReferenceScopePtr>) {
        self.children.push(child);
    }

    fn add_reference(&mut self, reference: Reference) {
        self.references.insert(reference);
    }

    fn is_visited(&self, reference: &Reference) -> bool {
        self.references.contains(reference)
    }

    fn add_reference_jsx(&mut self, reference: Reference) {
        self.jsx_references.insert(reference);
    }

    fn add_usage(&mut self, reference: Reference, usage: Usage) {
        self.usage_map
            .entry(reference)
            .or_insert(AHashSet::new())
            .insert(usage);
    }

    fn is_visited_jsx(&self, reference: &Reference) -> bool {
        self.jsx_references.contains(reference)
    }

    pub fn is_owned_by(&self, symbol: &Symbol) -> bool {
        symbol == &self.owner
    }

    pub fn get_references(&self) -> &AHashSet<Reference> {
        &self.references
    }
    pub fn get_usage_map(&self) -> &AHashMap<Reference, AHashSet<Usage>> {
        &self.usage_map
    }

    pub fn get_references_jsx(&self) -> &AHashSet<Reference> {
        &self.jsx_references
    }
}

impl Serialize for ReferenceScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut s = serializer.serialize_struct("ReferenceScope", 4)?;
        let parent = if let Some(p) = &self.parent {
            let parent_ctxt = p.upgrade().unwrap();
            Some(format!("{}", parent_ctxt.borrow().owner))
        } else {
            None
        };

        let cs = &self.children;
        let children: Vec<String> = cs
            .iter()
            .map(|c| format!("{}", &c.borrow().owner))
            .collect();

        let rs = &self.references;
        let mut references = rs
            .into_iter()
            .map(|c| format!("{}", c))
            .collect::<Vec<String>>();

        references.sort();

        let jrs = &self.jsx_references;
        let mut jsx_references = jrs
            .into_iter()
            .map(|c| format!("{}", c))
            .collect::<Vec<String>>();

        jsx_references.sort();

        s.serialize_field("owner", &self.owner)?;
        s.serialize_field("parent", &parent)?;
        s.serialize_field("children", &children)?;
        s.serialize_field("references", &references)?;
        s.serialize_field("jsx_references", &jsx_references)?;

        s.end()
    }
}

pub struct PropDefinitionFinder<'a> {
    props_symbol: Option<&'a Atom>,
    props: AHashMap<String, PropDefinition>,
    source_map: Arc<SourceMap>,
}

impl<'a> PropDefinitionFinder<'a> {
    fn new(source_map: Arc<SourceMap>) -> Self {
        Self {
            props_symbol: None,
            props: AHashMap::new(),
            source_map,
        }
    }

    fn add_prop_definition_if_not_exists(
        &mut self,
        prop_name: String,
        default_value: Option<PropValue>,
        start: CharacterPosition,
        end: CharacterPosition,
    ) {
        let entry = self
            .props
            .entry(prop_name.clone())
            .or_insert(PropDefinition {
                name: prop_name,
                default_value: None,
                start,
                end,
            });
        if let Some(default_value) = default_value {
            entry.default_value.get_or_insert(default_value);
        }
    }

    pub fn add_props_from_object_pattern(&mut self, value: &ObjectPattern) {
        for prop in value.props.iter() {
            match prop {
                ObjectPatternProp::Assign(prop) => {
                    let start =
                        CharacterPosition::from_loc(&self.source_map.lookup_char_pos(prop.span.lo));
                    let end =
                        CharacterPosition::from_loc(&self.source_map.lookup_char_pos(prop.span.hi));
                    self.add_prop_definition_if_not_exists(
                        prop.key.sym.to_string(),
                        prop.value
                            .as_ref()
                            .map(|expr| PropValue::from_expr(expr))
                            .flatten(),
                        start,
                        end,
                    );
                }
                ObjectPatternProp::KeyValue(prop) => match &prop.key {
                    PropName::Ident(ident) => {
                        let start = CharacterPosition::from_loc(
                            &self.source_map.lookup_char_pos(ident.span.lo),
                        );
                        let end = CharacterPosition::from_loc(
                            &self.source_map.lookup_char_pos(ident.span.hi),
                        );
                        self.add_prop_definition_if_not_exists(
                            ident.sym.to_string(),
                            match &prop.value.as_ref() {
                                EsPattern::Assign(assignment) => {
                                    PropValue::from_expr(assignment.right.as_ref())
                                }
                                _ => None,
                            },
                            start,
                            end,
                        );
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }

    pub fn find_prop_definitions(
        definition: &Definition,
        source_map: &Arc<SourceMap>,
    ) -> AHashMap<String, PropDefinition> {
        let body = match &definition {
            Definition::Decl(Decl::Fn(f)) => f
                .function
                .body
                .as_ref()
                .map(|block| ArrowFunctionBody::FunctionBody(block.clone())),
            Definition::Expr(Expr::Fn(f)) => f
                .function
                .body
                .as_ref()
                .map(|block| ArrowFunctionBody::FunctionBody(block.clone())),
            Definition::Expr(Expr::Arrow(f)) => Some(f.body.as_ref().clone()),
            _ => None,
        };

        let first_param = match &definition {
            Definition::Decl(Decl::Fn(f)) => f.function.params.get(0).map(|p| &p.pat),
            Definition::Expr(Expr::Fn(f)) => f.function.params.get(0).map(|p| &p.pat),
            Definition::Expr(Expr::Arrow(f)) => f.params.get(0),
            _ => None,
        };

        first_param.map_or(AHashMap::new(), |props_from_params| {
            let mut finder = Self::new(source_map.clone());

            match props_from_params {
                EsPattern::Object(o) => {
                    finder.add_props_from_object_pattern(o);

                    let rest_prop = o
                        .props
                        .iter()
                        .rfind(|prop| prop.is_rest())
                        .and_then(|s| s.as_rest())
                        .and_then(|rest| rest.arg.as_ident());

                    if let (Some(rest_ident), Some(b)) = (rest_prop, body) {
                        finder.props_symbol = Some(&rest_ident.id.sym);
                        b.visit_with(&mut finder);
                    }
                }
                EsPattern::Ident(ident) => {
                    if let Some(b) = body {
                        finder.props_symbol = Some(&ident.id.sym);
                        b.visit_with(&mut finder);
                    }
                }
                _ => {}
            };
            finder.props
        })
    }
}

impl<'a> Visit for PropDefinitionFinder<'a> {
    fn visit_var_declarator(&mut self, n: &VarDeclarator) {
        let is_props_declarator = || {
            n.init.as_ref().is_some_and(|expr| {
                if let Expr::Ident(ident) = expr.as_ref() {
                    self.props_symbol.is_some_and(|s| ident.sym.eq(s))
                } else {
                    false
                }
            })
        };
        if is_props_declarator() {
            if let EsPattern::Object(object) = &n.name {
                self.add_props_from_object_pattern(object);
            }
        }

        n.visit_children_with(self);
    }

    fn visit_member_expr(&mut self, n: &MemberExpr) {
        let is_props_member = || {
            if let Expr::Ident(ident) = n.obj.as_ref() {
                self.props_symbol.is_some_and(|s| ident.sym.eq(s))
            } else {
                false
            }
        };
        if is_props_member() {
            match &n.prop {
                MemberProp::Ident(ident) => {
                    let start = CharacterPosition::from_loc(
                        &self.source_map.lookup_char_pos(ident.span.lo),
                    );
                    let end = CharacterPosition::from_loc(
                        &self.source_map.lookup_char_pos(ident.span.hi),
                    );
                    self.add_prop_definition_if_not_exists(ident.sym.to_string(), None, start, end);
                }
                MemberProp::PrivateName(_) => {}
                MemberProp::Computed(computed) => {
                    if let Expr::Lit(Lit::Str(str)) = computed.expr.as_ref() {
                        let start = CharacterPosition::from_loc(
                            &self.source_map.lookup_char_pos(computed.span.lo),
                        );
                        let end = CharacterPosition::from_loc(
                            &self.source_map.lookup_char_pos(computed.span.hi),
                        );
                        self.add_prop_definition_if_not_exists(
                            str.value.to_string_lossy().into_owned(),
                            None,
                            start,
                            end,
                        );
                    }
                }
            }
        }

        n.visit_children_with(self);
    }
}

#[derive(Serialize, Debug)]
pub struct PropDefinition {
    pub name: String,
    pub default_value: Option<PropValue>,
    pub start: CharacterPosition,
    pub end: CharacterPosition,
}

#[derive(Debug, Hash, Clone, PartialEq, Eq)]
pub enum Definition {
    Empty,
    Decl(Decl),
    Expr(Expr),
    ExprWithMembers {
        expr: Expr,
        member_properties: Vec<MemberProperty>,
    },
    ExternalSymbol(SymbolWithSource),
    Parameter {
        function: Symbol,
        index: usize,
        member_properties: Vec<MemberProperty>,
    },
}

impl From<&Decl> for Definition {
    fn from(decl: &Decl) -> Self {
        Definition::Decl(decl.clone())
    }
}

impl Serialize for Definition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let string = match self {
            Definition::Empty => String::from("<empty>"),
            Definition::Decl(_) => String::from("<declaration>"),
            Definition::Expr(_) => String::from("<expression>"),
            Definition::ExprWithMembers { .. } => String::from("<expression>"),
            Definition::ExternalSymbol(es) => format!("ExternalSymbol<{:?}>", es),
            Definition::Parameter {
                function,
                index,
                member_properties,
            } => format!(
                "Parameter<{:?}>[{}]{}",
                function,
                index,
                member_properties
                    .iter()
                    .fold(String::new(), |acc, member_property| format!(
                        "[{acc}{member_property}]"
                    ))
            ),
        };

        serializer.serialize_str(string.as_str())
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub enum InferredType {
    Class(Rc<InferredType>),
    Function(Vec<Rc<InferredType>>),
    ReturnTypeOf(Rc<InferredType>, Vec<Rc<InferredType>>),
    MemberOf(Rc<InferredType>, MemberProperty),
    TypeOf {
        symbol: SymbolWithSource,
        is_local: bool,
    },
    Union(Vec<Rc<InferredType>>),
    Object(AHashMap<String, Rc<InferredType>>),
    Array(Vec<Rc<InferredType>>),
    ParameterOf {
        function: SymbolWithSource,
        index: usize,
    },
    JSX,
    Str(String),
    Unknown,
}

impl InferredType {
    pub fn merge_with_member_properties(
        obj_type: Rc<Self>,
        member_properties: &mut Vec<MemberProperty>,
    ) -> Rc<Self> {
        if let Some(member_property) = member_properties.pop() {
            Rc::new(InferredType::MemberOf(
                Self::merge_with_member_properties(obj_type, member_properties),
                member_property,
            ))
        } else {
            obj_type
        }
    }

    pub fn to_reference_with_source(
        value: &Rc<InferredType>,
    ) -> Option<(ReferenceWithSource, bool)> {
        match value.as_ref() {
            InferredType::TypeOf { symbol, is_local } => {
                Some((symbol.clone().into(), is_local.clone()))
            }
            InferredType::MemberOf(obj, member) => match obj.as_ref() {
                InferredType::Object(obj) => {
                    if let MemberProperty::Object(key) = member {
                        obj.get(key)
                            .map_or(None, |v| Self::to_reference_with_source(v))
                    } else {
                        None
                    }
                }
                InferredType::Array(arr) => {
                    if let MemberProperty::Array(idx) = member {
                        arr.get(*idx)
                            .map_or(None, |v| Self::to_reference_with_source(v))
                    } else {
                        None
                    }
                }
                _ => Self::to_reference_with_source(obj).map(|(reference, is_local)| {
                    let mut result = reference.clone();
                    result.push_member_property(member.clone());
                    (result, is_local)
                }),
            },
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq, Derivative)]
#[derivative(Hash)]
pub struct Declaration {
    pub symbol: Symbol,
    pub source: ModuleId,
    #[derivative(Hash = "ignore")]
    pub definition: Definition,
    #[derivative(Hash = "ignore")]
    pub inferred_type: Rc<InferredType>,
    pub start: Option<CharacterPosition>,
    pub end: Option<CharacterPosition>,
}

impl Declaration {
    fn new(
        symbol: Symbol,
        source: ModuleId,
        definition: Definition,
        inferred_type: Rc<InferredType>,
        start: Option<CharacterPosition>,
        end: Option<CharacterPosition>,
    ) -> Self {
        Self {
            symbol,
            source,
            definition,
            inferred_type,
            start,
            end,
        }
    }

    pub fn get_symbol_with_source(&self) -> SymbolWithSource {
        SymbolWithSource::new(self.symbol.clone(), self.source.clone())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct SymbolWithSource {
    pub symbol: Symbol,
    pub source: ModuleId,
}

impl SymbolWithSource {
    pub fn new(symbol: Symbol, source: ModuleId) -> Self {
        Self { symbol, source }
    }

    pub fn get_name(&self) -> String {
        self.symbol.get_name()
    }

    pub fn is_local(&self) -> bool {
        self.source.is_local()
    }

    pub fn is_external(&self) -> bool {
        self.source.is_external()
    }
}

impl Ord for SymbolWithSource {
    fn cmp(&self, other: &Self) -> Ordering {
        let ord = self.source.cmp(&other.source);

        match ord {
            Ordering::Equal => self.symbol.cmp(&other.symbol),
            _ => ord,
        }
    }
}

impl PartialOrd for SymbolWithSource {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct ReferenceWithSource {
    pub reference: Reference,
    pub source: ModuleId,
}

impl ReferenceWithSource {
    pub fn new(reference: Reference, source: ModuleId) -> Self {
        Self { reference, source }
    }

    pub fn is_local(&self) -> bool {
        self.source.is_local()
    }

    pub fn is_external(&self) -> bool {
        self.source.is_external()
    }

    pub fn push_member_property(&mut self, member_property: MemberProperty) {
        self.reference.push_member_property(member_property);
    }

    pub fn get_name(&self) -> String {
        self.reference.get_name()
    }

    pub fn get_name_with_member_properties(&self) -> String {
        self.reference.get_name_with_member_properties()
    }

    pub fn has_member_property(&self) -> bool {
        self.reference.has_member_property()
    }
}

impl From<ReferenceWithSource> for SymbolWithSource {
    fn from(value: ReferenceWithSource) -> Self {
        Self {
            symbol: value.reference.symbol,
            source: value.source.clone(),
        }
    }
}

impl From<SymbolWithSource> for ReferenceWithSource {
    fn from(value: SymbolWithSource) -> Self {
        Self {
            reference: value.symbol.into(),
            source: value.source.clone(),
        }
    }
}

struct EsModuleChecker {
    found: bool,
}

impl EsModuleChecker {
    fn is_es_module(module: &SwcModule) -> bool {
        let mut finder = EsModuleChecker { found: false };

        module.visit_with(&mut finder);

        finder.found
    }
}

impl Visit for EsModuleChecker {
    fn visit_module_decl(&mut self, n: &ModuleDecl) {
        match n {
            ModuleDecl::Import(_)
            | ModuleDecl::ExportDecl(_)
            | ModuleDecl::ExportNamed(_)
            | ModuleDecl::ExportDefaultDecl(_)
            | ModuleDecl::ExportDefaultExpr(_)
            | ModuleDecl::ExportAll(_) => self.found = true,
            ModuleDecl::TsImportEquals(_)
            | ModuleDecl::TsExportAssignment(_)
            | ModuleDecl::TsNamespaceExport(_) => self.found = false,
        }

        n.visit_children_with(self);
    }
}

type CodeSpan = (u32, u32);

pub struct Inspector {
    anon_id_counter: u32,
    src_module_id: ModuleId,
    export_items: Vec<Rc<ModuleExport>>,
    declarations: AHashMap<Symbol, Rc<Declaration>>,
    assignments: BTreeMap<Rc<Reference>, Rc<Declaration>>,
    scopes: Vec<Rc<ReferenceScopePtr>>,
    current_scope: Rc<ReferenceScopePtr>,
    module_resolver: Rc<ModuleResolver>,
    visited_declarations: AHashSet<CodeSpan>,
    source_map: Arc<SourceMap>,
}

impl Inspector {
    pub fn new(
        src_module_id: ModuleId,
        module_resolver: Rc<ModuleResolver>,
        source_map: Arc<SourceMap>,
    ) -> Self {
        let global = Rc::new(RefCell::new(ReferenceScope::global()));

        Self {
            anon_id_counter: 0,
            src_module_id,
            export_items: vec![],
            declarations: AHashMap::new(),
            assignments: BTreeMap::new(),
            scopes: vec![global.clone()],
            current_scope: global,
            module_resolver,
            visited_declarations: AHashSet::new(),
            source_map,
        }
    }

    fn generate_anon_symbol(&mut self) -> Symbol {
        self.anon_id_counter += 1;

        Symbol::anonymous(self.anon_id_counter)
    }

    fn is_visited(&self, reference: &Reference) -> bool {
        self.current_scope.borrow().is_visited(reference)
    }

    fn is_visited_jsx(&self, reference: &Reference) -> bool {
        self.current_scope.borrow().is_visited_jsx(reference)
    }

    fn begin_scope(&mut self, symbol: &Symbol) {
        let new_ctxt = Rc::new(RefCell::new(ReferenceScope::new(
            symbol,
            &self.current_scope,
        )));

        self.scopes.push(new_ctxt.clone());
        self.current_scope.borrow_mut().add_child(new_ctxt.clone());
        self.current_scope = new_ctxt;
    }
    fn end_current_scope(&mut self) {
        let current_ref = self.current_scope.clone();
        let current = current_ref.borrow();

        // TODO: Return a Result with a proper error if this is called on the global scope
        if !current.is_global() {
            let new_current = current.parent.as_ref().unwrap();

            self.current_scope = new_current.clone().upgrade().unwrap();
        }
    }

    fn capture_reference(&mut self, reference: Reference, used_as_jsx: bool) {
        if used_as_jsx {
            if !self.is_visited_jsx(&reference) {
                let mut current_scope = self.current_scope.borrow_mut();

                current_scope.add_reference_jsx(reference);
            }
        } else if !self.is_visited(&reference) {
            let mut current_scope = self.current_scope.borrow_mut();
            current_scope.add_reference(reference);
        }
    }

    fn add_usage(&mut self, reference: Reference, element: &JSXElement) {
        let mut current_scope = self.current_scope.borrow_mut();
        current_scope.add_usage(
            reference,
            Usage::from_jsx_element(element, &self.source_map),
        )
    }

    fn add_declaration(&mut self, symbol: Symbol, definition: Definition, span: CodeSpan) {
        // TODO: This happens duplicate visits to same nodes, we should fix this in the visitor impl
        if self.visited_declarations.contains(&span) {
            return;
        }

        let inferred_type = self.process_definition(&definition);
        let start_pos = CharacterPosition::from_loc(
            &self.source_map.lookup_char_pos(swc_common::BytePos(span.0)),
        );
        let end_pos = CharacterPosition::from_loc(
            &self.source_map.lookup_char_pos(swc_common::BytePos(span.1)),
        );

        self.declarations.insert(
            symbol.clone(),
            Rc::new(Declaration::new(
                symbol,
                self.src_module_id.clone(),
                definition,
                inferred_type,
                Some(start_pos),
                Some(end_pos),
            )),
        );

        self.visited_declarations.insert(span);
    }

    fn get_declaration(&self, symbol: &Symbol) -> Option<&Rc<Declaration>> {
        self.declarations.get(symbol)
    }

    fn add_export(
        &mut self,
        exported_name: Symbol,
        source_name: Symbol,
        source_module: Option<ModuleId>,
    ) {
        let source = if let Some(source_mid) = source_module {
            if source_name.is_wildcard() && !exported_name.is_wildcard() {
                // If it's named wildcard export we should add it as a declaration
                // e.g. export * as foo from "./bar";
                Some(ExportSource::Internal(exported_name.clone()))
            } else {
                Some(ExportSource::External(SymbolWithSource::new(
                    source_name,
                    source_mid,
                )))
            }
        } else {
            // Declaration can be missing if it's a TS declaration
            self.get_declaration(&source_name)
                .map(|_| ExportSource::Internal(source_name.clone()))
        };

        if let Some(export_source) = source {
            self.export_items.push(Rc::new(ModuleExport {
                source: export_source,
                exported_name: exported_name.get_name(),
            }));
        }
    }

    fn add_assignment(&mut self, reference: Reference, declaration: Rc<Declaration>) {
        self.assignments.insert(Rc::new(reference), declaration);
    }

    fn extract_symbols_from_pattern(
        &mut self,
        pattern: &EsPattern,
        member_properties: Vec<MemberProperty>,
    ) -> Vec<(Symbol, Span, Vec<MemberProperty>)> {
        let mut symbols = vec![];

        match pattern {
            EsPattern::Ident(bid) => {
                symbols.push((Symbol::from(&bid.id), bid.id.span, member_properties));
            }
            EsPattern::Object(obj) => {
                symbols.extend(obj.props.iter().flat_map(|prop| match prop {
                    ObjectPatternProp::Assign(assign) => {
                        let mut member_properties = member_properties.clone();
                        member_properties.push(MemberProperty::Object(assign.key.sym.to_string()));

                        vec![(Symbol::from(&assign.key.id), assign.span, member_properties)]
                    }
                    ObjectPatternProp::KeyValue(kv) => {
                        let mut member_properties = member_properties.clone();
                        member_properties
                            .push(MemberProperty::Object(Self::prop_to_string(&kv.key)));

                        self.extract_symbols_from_pattern(&kv.value, member_properties)
                    }
                    ObjectPatternProp::Rest(rest) => {
                        self.extract_symbols_from_pattern(&rest.arg, vec![])
                    }
                }))
            }
            EsPattern::Array(arr) => symbols.extend(
                arr.elems
                    .iter()
                    .enumerate()
                    .filter_map(|(index, elem)| {
                        elem.as_ref().map(|e| {
                            let mut member_properties = member_properties.clone();
                            member_properties.push(MemberProperty::Array(index));
                            self.extract_symbols_from_pattern(e, member_properties)
                        })
                    })
                    .flatten(),
            ),
            EsPattern::Rest(rest) => {
                symbols.extend(self.extract_symbols_from_pattern(&rest.arg, vec![]));
            }
            EsPattern::Assign(assign) => {
                symbols.extend(self.extract_symbols_from_pattern(&assign.left, vec![]));
            }
            _ => {}
        };

        symbols
    }

    fn get_module_id_for(&self, import_path: &str) -> ModuleId {
        self.module_resolver
            .resolve_import_path(import_path, &self.src_module_id)
    }

    fn handle_parameters(&mut self, function: &Symbol, params: &Vec<&EsPattern>) {
        for (index, param) in params.iter().enumerate() {
            for (symbol, span, member_properties) in
                self.extract_symbols_from_pattern(&param, vec![])
            {
                self.add_declaration(
                    symbol,
                    Definition::Parameter {
                        function: function.clone(),
                        index,
                        member_properties,
                    },
                    (span.lo.0, span.hi.0),
                )
            }
        }
    }

    fn handle_parameters_of_expr(&mut self, expr_symbol: &Symbol, expr: &Expr) {
        match expr {
            Expr::Fn(fn_expr) => {
                self.handle_parameters(
                    expr_symbol,
                    &fn_expr
                        .function
                        .params
                        .iter()
                        .map(|Param { pat, .. }| pat)
                        .collect(),
                );
            }
            Expr::Arrow(arrow_expr) => {
                self.handle_parameters(expr_symbol, &arrow_expr.params.iter().collect());
            }
            _ => {}
        }
    }

    fn handle_var_declarator(&mut self, declarator: &VarDeclarator) {
        for (symbol, span, member_properties) in
            self.extract_symbols_from_pattern(&declarator.name, vec![])
        {
            if let Some(def) = declarator.init.as_ref() {
                self.begin_scope(&symbol);
                let expr = def.as_ref();
                expr.visit_with(self);

                self.handle_parameters_of_expr(&symbol, expr);

                let definition = if member_properties.is_empty() {
                    Definition::Expr(expr.clone())
                } else {
                    Definition::ExprWithMembers {
                        expr: expr.clone(),
                        member_properties,
                    }
                };

                self.add_declaration(symbol, definition, (span.lo.0, span.hi.0));

                self.end_current_scope();
            } else {
                self.add_declaration(symbol, Definition::Empty, (span.lo.0, span.hi.0))
            }
        }
    }

    fn handle_import_decl(&mut self, import_decl: &ImportDecl) {
        for specifier in &import_decl.specifiers {
            let import_path = import_decl.src.value.to_string_lossy().into_owned();
            let source = self.get_module_id_for(&import_path);

            match specifier {
                ImportSpecifier::Named(named) => self.add_declaration(
                    (&named.local).into(),
                    Definition::ExternalSymbol(SymbolWithSource::new(Symbol::from(named), source)),
                    (named.span.lo.0, named.span.hi.0),
                ),
                ImportSpecifier::Default(default) => self.add_declaration(
                    (&default.local).into(),
                    Definition::ExternalSymbol(SymbolWithSource::new(Symbol::default(), source)),
                    (default.span.lo.0, default.span.hi.0),
                ),
                ImportSpecifier::Namespace(namespace) => self.add_declaration(
                    (&namespace.local).into(),
                    Definition::ExternalSymbol(SymbolWithSource::new(Symbol::wildcard(), source)),
                    (namespace.span.lo.0, namespace.span.hi.0),
                ),
            }
        }
    }

    fn handle_export_decl(&mut self, n: &ExportDecl) {
        match &n.decl {
            Decl::Class(cls) => {
                // TODO: This should be handled by visit_decl
                self.handle_class_decl(cls);

                self.add_export(Symbol::from(&cls.ident), Symbol::from(&cls.ident), None);
            }
            Decl::Fn(func) => {
                // TODO: This should be handled by visit_decl
                self.handle_fn_decl(func);

                self.add_export(Symbol::from(&func.ident), Symbol::from(&func.ident), None);
            }
            Decl::Var(var) => {
                for var_decl in &var.decls {
                    // TODO: This should be handled by visit_var_declarator
                    self.handle_var_declarator(var_decl);

                    for (symbol, ..) in self.extract_symbols_from_pattern(&var_decl.name, vec![]) {
                        self.add_export(symbol.clone(), symbol.clone(), None);
                    }
                }
            }
            _ => {}
        };
    }

    fn handle_export_all(&mut self, n: &ExportAll) {
        let source_id = self.get_module_id_for(&n.src.value.to_string_lossy());
        self.add_export(Symbol::wildcard(), Symbol::wildcard(), Some(source_id));
    }

    fn handle_export_default_decl(&mut self, n: &ExportDefaultDecl) {
        match &n.decl {
            DefaultDecl::Class(class_expr) => {
                let symbol = if let Some(ident) = class_expr.ident.as_ref() {
                    Symbol::from(ident)
                } else {
                    self.generate_anon_symbol()
                };

                self.begin_scope(&symbol);

                class_expr.class.visit_with(self);

                let definition = Definition::Expr(Expr::Class(class_expr.clone()));

                self.add_declaration(
                    symbol.clone(),
                    definition,
                    (class_expr.class.span.lo.0, class_expr.class.span.hi.0),
                );

                self.end_current_scope();

                self.add_export(Symbol::default(), symbol, None);
            }
            DefaultDecl::Fn(fn_expr) => {
                let symbol = if let Some(ident) = fn_expr.ident.as_ref() {
                    Symbol::from(ident)
                } else {
                    self.generate_anon_symbol()
                };

                self.handle_parameters(
                    &symbol,
                    &fn_expr
                        .function
                        .params
                        .iter()
                        .map(|Param { pat, .. }| pat)
                        .collect(),
                );

                self.begin_scope(&symbol);

                fn_expr.function.visit_with(self);

                let definition = Definition::Expr(Expr::Fn(fn_expr.clone()));

                self.add_declaration(
                    symbol.clone(),
                    definition,
                    (fn_expr.function.span.lo.0, fn_expr.function.span.hi.0),
                );

                self.end_current_scope();

                self.add_export(Symbol::default(), symbol, None);
            }
            _ => {}
        }
    }

    fn handle_export_default_expr(&mut self, n: &ExportDefaultExpr) {
        let symbol = Symbol::default();
        self.begin_scope(&symbol);

        n.expr.visit_with(self);

        self.handle_parameters_of_expr(&symbol, n.expr.as_ref());

        self.add_declaration(
            symbol,
            Definition::Expr(n.expr.as_ref().clone()),
            (n.span.lo.0, n.span.hi.0),
        );

        self.end_current_scope();

        self.add_export(Symbol::default(), Symbol::default(), None);
    }

    fn handle_named_export(&mut self, n: &NamedExport) {
        let source = match n.src.as_ref() {
            Some(src) => Some(self.get_module_id_for(&src.value.to_string_lossy())),
            None => None,
        };

        for specifier in &n.specifiers {
            match specifier {
                ExportSpecifier::Namespace(ns) => {
                    let exported_symbol: Symbol = (&ns.name).into();
                    if !exported_symbol.is_wildcard() {
                        // If it's named wildcard export we should add it as a declaration
                        // e.g. export * as foo from "./bar";
                        self.add_declaration(
                            exported_symbol.clone(),
                            Definition::ExternalSymbol(SymbolWithSource::new(
                                Symbol::wildcard(),
                                source.clone().unwrap(),
                            )),
                            (n.span.lo.0, n.span.hi.0),
                        );
                    }

                    self.add_export(exported_symbol, Symbol::wildcard(), source.clone())
                }
                ExportSpecifier::Default(d) => {
                    self.add_export((&d.exported).into(), Symbol::default(), source.clone())
                }
                ExportSpecifier::Named(nd) => {
                    let exported_name = if let Some(export_name) = &nd.exported {
                        Symbol::from(export_name)
                    } else {
                        Symbol::from(&nd.orig)
                    };

                    let source_name = Symbol::from(&nd.orig);

                    self.add_export(exported_name, source_name, source.clone());
                }
            }
        }
    }

    fn handle_class_decl(&mut self, class_decl: &ClassDecl) {
        let symbol = (&class_decl.ident).into();
        self.begin_scope(&symbol);

        class_decl.class.visit_with(self);

        let definition = Definition::from(&Decl::Class(class_decl.clone()));

        self.add_declaration(
            symbol,
            definition,
            (class_decl.class.span.lo.0, class_decl.class.span.hi.0),
        );

        self.end_current_scope();
    }

    fn handle_fn_decl(&mut self, fn_decl: &FnDecl) {
        let symbol = (&fn_decl.ident).into();
        self.begin_scope(&symbol);

        self.handle_parameters(
            &symbol,
            &fn_decl
                .function
                .params
                .iter()
                .map(|Param { pat, .. }| pat)
                .collect(),
        );

        fn_decl.function.visit_with(self);

        let definition = Definition::from(&Decl::Fn(fn_decl.clone()));

        self.add_declaration(
            symbol,
            definition,
            (fn_decl.function.span.lo.0, fn_decl.function.span.hi.0),
        );

        self.end_current_scope();
    }

    fn handle_class_expr(&mut self, class_expr: &ClassExpr) {
        let symbol = if let Some(ident) = class_expr.ident.as_ref() {
            Symbol::from(ident)
        } else {
            self.generate_anon_symbol()
        };

        self.begin_scope(&symbol);

        class_expr.class.visit_with(self);

        let definition = Definition::Expr(Expr::Class(class_expr.clone()));

        self.add_declaration(
            symbol,
            definition,
            (class_expr.class.span.lo.0, class_expr.class.span.hi.0),
        );

        self.end_current_scope();
    }

    fn handle_assign_expr(&mut self, assign_expr: &AssignExpr) {
        if assign_expr.op == AssignOp::Assign {
            if let Some(SimpleAssignTarget::Member(member_expr)) = assign_expr.left.as_simple() {
                member_expr.visit_with(self);
                let member_expr_reference =
                    InferredType::to_reference_with_source(&self.process_member_expr(member_expr));
                if let Some(left) = member_expr_reference {
                    if let Some(right) = &assign_expr.right.as_ident() {
                        let symbol = Symbol::from(*right);
                        if let Some(decl) = self.get_declaration(&symbol) {
                            self.add_assignment(left.0.reference, decl.clone());
                        }
                    }
                }
            }
        }
    }

    fn handle_assign_props(
        &mut self,
        props: &AHashMap<String, Rc<InferredType>>,
        source_ref: Reference,
    ) {
        for (key, value) in props.iter() {
            match value.as_ref() {
                InferredType::TypeOf {
                    symbol,
                    is_local: _,
                } => {
                    let mut reference = Reference::from(source_ref.clone());
                    reference.push_member_property(MemberProperty::Object(key.clone()));
                    let Some(declaration) = self.get_declaration(&symbol.symbol) else {
                        continue;
                    };
                    self.add_assignment(reference, declaration.clone());
                }
                InferredType::Object(props) => {
                    let mut reference = Reference::from(source_ref.clone());
                    reference.push_member_property(MemberProperty::Object(key.clone()));
                    self.handle_assign_props(props, reference);
                }
                _ => {}
            };
        }
    }

    fn handle_call_expr(&mut self, call_expr: &CallExpr) {
        let Callee::Expr(expr) = &call_expr.callee else {
            return;
        };
        let Expr::Member(member_expr) = expr.as_ref() else {
            return;
        };
        let Expr::Ident(obj_name) = member_expr.obj.as_ref() else {
            return;
        };
        let MemberProp::Ident(prop_name) = &member_expr.prop else {
            return;
        };
        if Symbol::from(obj_name).eq_name("Object") && Symbol::from(prop_name).eq_name("assign") {
            let mut args = call_expr.args.iter();
            let Some(expr_or_spread) = args.next() else {
                return;
            };
            let Expr::Ident(source_name_ident) = expr_or_spread.expr.as_ref() else {
                return;
            };
            let source_symbol = Symbol::from(source_name_ident);
            let Some(assigned) = args.next() else {
                return;
            };
            let Expr::Object(assign_obj) = assigned.expr.as_ref() else {
                return;
            };
            let props = self.process_object_expr(&assign_obj);
            let InferredType::Object(props) = props.as_ref() else {
                return;
            };
            let reference = Reference::from(source_symbol);
            self.handle_assign_props(props, reference);
        }
    }

    fn handle_fn_expr(&mut self, fn_expr: &FnExpr) {
        let symbol = if let Some(ident) = fn_expr.ident.as_ref() {
            Symbol::from(ident)
        } else {
            self.generate_anon_symbol()
        };

        self.handle_parameters(
            &symbol,
            &fn_expr
                .function
                .params
                .iter()
                .map(|Param { pat, .. }| pat)
                .collect(),
        );

        self.begin_scope(&symbol);

        fn_expr.function.visit_with(self);

        self.add_declaration(
            symbol,
            Definition::Expr(Expr::Fn(fn_expr.clone())),
            (fn_expr.function.span.lo.0, fn_expr.function.span.hi.0),
        );

        self.end_current_scope();
    }

    fn extend_exports(&mut self) {
        // find assignment sources in exported items and add them as exports, too
        let assignments = self.assignments.clone();
        for (assignment_reference, declaration) in assignments.iter() {
            if let Some(export_item) = self.export_items.iter().find(|export| {
                let export_symbol = match &export.source {
                    ExportSource::External(ex) => ex.symbol.clone(),
                    ExportSource::Internal(ex) => ex.clone(),
                };
                if let Some(decl) = self.get_declaration(&export_symbol) {
                    // export itself
                    if decl
                        .symbol
                        .eq_name(assignment_reference.get_name().as_str())
                    {
                        return true;
                    }
                    // default export
                    if let Some(reference) =
                        InferredType::to_reference_with_source(&decl.inferred_type)
                    {
                        if assignment_reference.get_name() == reference.0.reference.get_name() {
                            return true;
                        }
                    }
                }
                false
            }) {
                match declaration.definition.clone() {
                    Definition::ExternalSymbol(ext_sym) => {
                        self.add_export(
                            Symbol::from(
                                assignment_reference
                                    .get_exported_name_with_member_properties(
                                        export_item.exported_name.clone(),
                                    )
                                    .as_str(),
                            ),
                            ext_sym.symbol,
                            Some(ext_sym.source),
                        );
                    }
                    Definition::Decl(_) | Definition::Expr(_) => {
                        self.add_export(
                            Symbol::from(
                                assignment_reference
                                    .get_exported_name_with_member_properties(
                                        export_item.exported_name.clone(),
                                    )
                                    .as_str(),
                            ),
                            Symbol::from(declaration.symbol.clone()),
                            None,
                        );
                    }
                    _ => {}
                };
            }
        }
    }

    pub fn collect_exports(&mut self) -> Vec<Rc<ModuleExport>> {
        (&self.export_items).to_vec()
    }

    pub fn collect_declarations(&self) -> Vec<Rc<Declaration>> {
        let mut ids = (&self.declarations)
            .into_iter()
            .map(|i| i.1.clone())
            .collect::<Vec<Rc<Declaration>>>();

        ids.sort_by(|i1, i2| i1.symbol.partial_cmp(&i2.symbol).unwrap());

        ids
    }

    pub fn collect_scopes(&self) -> Vec<Rc<ReferenceScopePtr>> {
        (&self.scopes).to_vec()
    }

    fn find_return_stmts_in_stmt(stmt: &Stmt) -> Vec<&ReturnStmt> {
        match &stmt {
            Stmt::Return(rs) => vec![rs],
            Stmt::Block(block_stmt) => Inspector::find_return_stmts(&block_stmt.stmts),
            Stmt::If(if_stmt) => {
                let mut return_stmts = Inspector::find_return_stmts_in_stmt(&if_stmt.cons);

                if let Some(alt_stmt) = &if_stmt.alt {
                    return_stmts.extend(Inspector::find_return_stmts_in_stmt(alt_stmt));
                }

                return_stmts
            }
            Stmt::Switch(switch_stmt) => switch_stmt
                .cases
                .iter()
                .flat_map(|switch_case| {
                    switch_case
                        .cons
                        .iter()
                        .flat_map(Inspector::find_return_stmts_in_stmt)
                })
                .collect(),
            Stmt::Try(try_stmt) => {
                let mut return_stmts = Inspector::find_return_stmts(&try_stmt.block.stmts);

                if let Some(catch_clause) = &try_stmt.handler {
                    return_stmts.extend(Inspector::find_return_stmts(&catch_clause.body.stmts));
                }

                if let Some(finally_stmt) = &try_stmt.finalizer {
                    return_stmts.extend(Inspector::find_return_stmts(&finally_stmt.stmts));
                }

                return_stmts
            }
            Stmt::While(while_stmt) => Inspector::find_return_stmts_in_stmt(&while_stmt.body),
            Stmt::DoWhile(do_while_stmt) => {
                Inspector::find_return_stmts_in_stmt(&do_while_stmt.body)
            }
            Stmt::For(for_stmt) => Inspector::find_return_stmts_in_stmt(&for_stmt.body),
            Stmt::ForIn(for_in_stmt) => Inspector::find_return_stmts_in_stmt(&for_in_stmt.body),
            Stmt::ForOf(for_of_stmt) => Inspector::find_return_stmts_in_stmt(&for_of_stmt.body),
            _ => vec![],
        }
    }

    fn find_return_stmts(stmts: &[Stmt]) -> Vec<&ReturnStmt> {
        stmts
            .iter()
            .flat_map(Inspector::find_return_stmts_in_stmt)
            .collect()
    }

    pub fn process_definition(&self, definition: &Definition) -> Rc<InferredType> {
        match definition {
            Definition::Empty => Rc::new(InferredType::Unknown),
            Definition::Decl(decl) => self.process_decl(decl),
            Definition::ExprWithMembers {
                expr,
                member_properties,
            } => InferredType::merge_with_member_properties(
                self.process_expr(expr),
                &mut member_properties.clone(),
            ),
            Definition::Expr(expr) => self.process_expr(expr),
            Definition::ExternalSymbol(es) => Rc::new(InferredType::TypeOf {
                symbol: es.clone().into(),
                is_local: false,
            }),
            Definition::Parameter {
                function,
                index,
                member_properties,
            } => {
                let result = Rc::new(InferredType::ParameterOf {
                    function: SymbolWithSource::new(function.clone(), self.src_module_id.clone()),
                    index: index.clone(),
                });
                if member_properties.is_empty() {
                    result
                } else {
                    InferredType::merge_with_member_properties(
                        result,
                        &mut member_properties.clone(),
                    )
                }
            }
        }
    }

    fn process_ident(&self, ident: &Ident) -> Rc<InferredType> {
        Rc::new(InferredType::TypeOf {
            symbol: SymbolWithSource::new(ident.into(), self.src_module_id.clone()),
            is_local: true,
        })
    }

    fn process_literal(&self, literal: &Lit) -> Rc<InferredType> {
        match literal {
            Lit::JSXText(_) => Rc::new(InferredType::JSX),
            Lit::Str(s) => Rc::new(InferredType::Str(s.value.to_string_lossy().into_owned())),
            _ => Rc::new(InferredType::Unknown),
        }
    }

    fn process_block_stmt(&self, block: &FunctionBody) -> Rc<InferredType> {
        let return_stmts = Inspector::find_return_stmts(&block.stmts);

        let mut inferred_type_vec = vec![];
        for return_stmt in return_stmts {
            if let Some(expr) = &return_stmt.arg {
                let inferred_type = self.process_expr(expr);

                match inferred_type.deref() {
                    InferredType::Union(type_vec) => inferred_type_vec.extend(type_vec.clone()),
                    _ => inferred_type_vec.push(inferred_type),
                }
            }
        }

        Rc::new(InferredType::Union(inferred_type_vec))
    }

    fn process_function(&self, func: &Function) -> Rc<InferredType> {
        func.body
            .as_ref()
            .map_or(Rc::new(InferredType::Unknown), |block| {
                let inferred_type = self.process_block_stmt(block);

                if let InferredType::Union(return_types) = inferred_type.deref() {
                    Rc::new(InferredType::Function(return_types.clone()))
                } else {
                    Rc::new(InferredType::Function(vec![Rc::new(InferredType::Unknown)]))
                }
            })
    }

    fn process_arrow_expr(&self, arrow: &ArrowExpr) -> Rc<InferredType> {
        let return_types = match arrow.body.as_ref() {
            ArrowFunctionBody::FunctionBody(block) => {
                let inferred_type = self.process_block_stmt(block);

                if let InferredType::Union(return_types) = inferred_type.deref() {
                    return_types.clone()
                } else {
                    vec![Rc::new(InferredType::Unknown)]
                }
            }
            ArrowFunctionBody::Expr(expr) => {
                vec![self.process_expr(expr.as_ref())]
            }
        };

        Rc::new(InferredType::Function(return_types))
    }

    fn process_call_expr(&self, call: &CallExpr) -> Rc<InferredType> {
        match &call.callee {
            Callee::Expr(expr) => {
                let callee_type = self.process_expr(expr.as_ref());

                let arg_types = call
                    .args
                    .iter()
                    .map(|arg| self.process_expr(&arg.expr))
                    .collect();

                Rc::new(InferredType::ReturnTypeOf(callee_type, arg_types))
            }
            Callee::Import(_) => call
                .args
                .get(0)
                .and_then(|arg| arg.expr.as_lit())
                .and_then(|lit| match lit {
                    Lit::Str(str) => Some(self.get_module_id_for(&str.value.to_string_lossy())),
                    _ => None,
                })
                .map_or_else(
                    || Rc::new(InferredType::Unknown),
                    |module_id| {
                        Rc::new(InferredType::TypeOf {
                            symbol: SymbolWithSource::new(Symbol::wildcard(), module_id),
                            is_local: false,
                        })
                    },
                ),
            _ => Rc::new(InferredType::Unknown),
        }
    }

    fn process_tagged_tpl_expr(&self, tagged_tpl: &TaggedTpl) -> Rc<InferredType> {
        let callee_type = match tagged_tpl.tag.as_ref() {
            Expr::Ident(ident) => self.process_ident(ident),
            Expr::Member(member) => self.process_member_expr(member),
            Expr::Paren(pexpr) => self.process_expr(&pexpr.expr),
            Expr::Call(call) => self.process_call_expr(call),
            _ => Rc::new(InferredType::Unknown),
        };

        if let InferredType::Unknown = *callee_type {
            callee_type
        } else {
            Rc::new(InferredType::ReturnTypeOf(Rc::clone(&callee_type), vec![]))
        }
    }

    fn process_conditional_expr(&self, cond: &CondExpr) -> Rc<InferredType> {
        Rc::new(InferredType::Union(vec![
            self.process_expr(cond.cons.as_ref()),
            self.process_expr(cond.alt.as_ref()),
        ]))
    }

    fn process_binary_expr(&self, bin: &BinExpr) -> Rc<InferredType> {
        Rc::new(InferredType::Union(vec![
            self.process_expr(bin.left.as_ref()),
            self.process_expr(bin.right.as_ref()),
        ]))
    }

    fn process_array_expr(&self, array: &ArrayLit) -> Rc<InferredType> {
        let mut types = vec![];

        for elem in &array.elems {
            if elem.is_none() {
                continue;
            }

            let elem = elem.as_ref().unwrap();
            if elem.spread.is_some() {
                continue;
            }

            types.push(self.process_expr(&elem.expr))
        }

        Rc::new(InferredType::Array(types))
    }

    fn prop_to_string(prop: &PropName) -> String {
        match prop {
            PropName::Ident(ident) => ident.sym.to_string(),
            PropName::Str(str) => str.value.to_string_lossy().into_owned(),
            PropName::Num(num) => num.value.to_string(),
            PropName::BigInt(big_int) => big_int.value.to_string(),
            PropName::Computed(_) => String::from("[computed]"),
        }
    }

    fn process_object_expr(&self, object: &ObjectLit) -> Rc<InferredType> {
        let mut types = AHashMap::new();

        for prop in &object.props {
            match prop {
                PropOrSpread::Spread(_) => continue,
                PropOrSpread::Prop(p) => {
                    let (prop_name, inferred_type) = match p.as_ref() {
                        Prop::Shorthand(ident) => {
                            (ident.sym.to_string(), self.process_ident(ident))
                        }
                        Prop::KeyValue(kv) => (
                            Inspector::prop_to_string(&kv.key),
                            self.process_expr(&kv.value),
                        ),
                        Prop::Getter(getter) => (
                            Inspector::prop_to_string(&getter.key),
                            getter
                                .function
                                .body
                                .as_ref()
                                .map_or(Rc::new(InferredType::Unknown), |block| {
                                    self.process_block_stmt(block)
                                }),
                        ),
                        Prop::Setter(_) => continue,
                        Prop::Method(method) => (
                            Inspector::prop_to_string(&method.key),
                            self.process_function(&method.function),
                        ),
                        Prop::Assign(_) => continue,
                    };

                    types.insert(prop_name, inferred_type);
                }
            }
        }

        Rc::new(InferredType::Object(types))
    }

    fn process_member_expr(&self, member: &MemberExpr) -> Rc<InferredType> {
        Rc::new(InferredType::MemberOf(
            self.process_expr(&member.obj),
            (&member.prop).into(),
        ))
    }

    fn process_class(&self, class: &Class) -> Rc<InferredType> {
        match &class.super_class {
            Some(expr) => {
                let super_type = self.process_expr(expr);

                Rc::new(InferredType::Class(super_type))
            }
            None => Rc::new(InferredType::Unknown),
        }
    }

    fn process_expr(&self, expr: &Expr) -> Rc<InferredType> {
        match expr {
            Expr::Class(class_expr) => self.process_class(&class_expr.class),
            Expr::Fn(func) => self.process_function(&func.function),
            Expr::Arrow(arrow) => self.process_arrow_expr(arrow),
            Expr::Call(call) => self.process_call_expr(call),
            Expr::TaggedTpl(tagged_tpl) => self.process_tagged_tpl_expr(tagged_tpl),
            Expr::Cond(cond) => self.process_conditional_expr(cond),
            Expr::Array(array) => self.process_array_expr(array),
            Expr::Object(object) => self.process_object_expr(object),
            Expr::Member(member) => self.process_member_expr(member),
            Expr::OptChain(opt_chain) => match opt_chain.base.as_ref() {
                OptChainBase::Member(member) => self.process_member_expr(member),
                OptChainBase::Call(opt_call) => self.process_call_expr(&opt_call.clone().into()),
            },
            Expr::Ident(ident) => self.process_ident(ident),
            Expr::Paren(paren) => self.process_expr(paren.expr.as_ref()),
            Expr::Await(await_expr) => self.process_expr(await_expr.arg.as_ref()),
            Expr::Lit(literal) => self.process_literal(literal),
            Expr::Bin(bin) => self.process_binary_expr(bin),

            Expr::TsAs(ts_as) => self.process_expr(ts_as.expr.as_ref()),
            Expr::TsConstAssertion(ts_const_asstn) => {
                self.process_expr(ts_const_asstn.expr.as_ref())
            }
            Expr::TsNonNull(ts_non_null) => self.process_expr(ts_non_null.expr.as_ref()),
            Expr::TsTypeAssertion(ts_type_asstn) => self.process_expr(ts_type_asstn.expr.as_ref()),
            Expr::TsSatisfies(ts_satisfies) => self.process_expr(ts_satisfies.expr.as_ref()),

            Expr::JSXEmpty(_) => Rc::new(InferredType::JSX),
            Expr::JSXElement(_) => Rc::new(InferredType::JSX),
            Expr::JSXFragment(_) => Rc::new(InferredType::JSX),

            _ => Rc::new(InferredType::Unknown),
        }
    }

    fn process_decl(&self, decl: &Decl) -> Rc<InferredType> {
        match decl {
            Decl::Fn(func) => self.process_function(&func.function),
            Decl::Class(class_decl) => self.process_class(&class_decl.class),
            _ => Rc::new(InferredType::Unknown),
        }
    }

    pub fn inspect(&mut self, module: &SwcModule) {
        if !EsModuleChecker::is_es_module(module) {
            return;
        }

        module.visit_with(self);

        self.extend_exports();
    }
}

impl Visit for Inspector {
    fn visit_module_decl(&mut self, n: &ModuleDecl) {
        match n {
            ModuleDecl::Import(import_decl) => self.handle_import_decl(import_decl),
            // Following Expr variants should have been visited by visit_expr method
            // but it misses them for some reason
            ModuleDecl::ExportDefaultDecl(default_decl) => {
                self.handle_export_default_decl(default_decl)
            }
            ModuleDecl::ExportDefaultExpr(default_expr) => {
                self.handle_export_default_expr(default_expr)
            }
            ModuleDecl::ExportDecl(export_decl) => self.handle_export_decl(export_decl),
            ModuleDecl::ExportNamed(e) => self.handle_named_export(e),
            ModuleDecl::ExportAll(e) => self.handle_export_all(e),
            ModuleDecl::TsImportEquals(_)
            | ModuleDecl::TsExportAssignment(_)
            | ModuleDecl::TsNamespaceExport(_) => {}
        };

        n.visit_children_with(self);
    }

    fn visit_ident(&mut self, n: &Ident) {
        self.capture_reference(Symbol::from(n).into(), false);

        n.visit_children_with(self);
    }

    fn visit_decl(&mut self, n: &Decl) {
        match n {
            Decl::Class(class_decl) => self.handle_class_decl(class_decl),
            Decl::Fn(fn_decl) => self.handle_fn_decl(fn_decl),
            _ => {}
        }

        n.visit_children_with(self);
    }

    fn visit_default_decl(&mut self, n: &DefaultDecl) {
        match n {
            DefaultDecl::Class(class_expr) => self.handle_class_expr(class_expr),
            DefaultDecl::Fn(fn_expr) => self.handle_fn_expr(fn_expr),
            _ => {}
        }

        n.visit_children_with(self);
    }

    fn visit_expr(&mut self, n: &Expr) {
        match n {
            Expr::Class(class_expr) => self.handle_class_expr(class_expr),
            Expr::Fn(fn_expr) => self.handle_fn_expr(fn_expr),
            Expr::Assign(assign_expr) => self.handle_assign_expr(assign_expr),
            Expr::Call(call_expr) => self.handle_call_expr(call_expr),
            _ => {}
        }

        n.visit_children_with(self);
    }

    fn visit_var_declarator(&mut self, n: &VarDeclarator) {
        self.handle_var_declarator(n);

        n.visit_children_with(self);
    }

    fn visit_jsx_element(&mut self, n: &JSXElement) {
        match &n.opening.name {
            JSXElementName::Ident(ident) => {
                self.add_usage(Symbol::from(ident).into(), n);
                self.capture_reference(Symbol::from(ident).into(), true);
            }
            JSXElementName::JSXMemberExpr(jsx_member_expr) => {
                self.add_usage(jsx_member_expr.into(), n);
                self.capture_reference(jsx_member_expr.into(), true);
            }
            JSXElementName::JSXNamespacedName(_) => {}
        }

        n.visit_children_with(self);
    }
}

#[derive(Debug, Serialize, Hash, Clone, PartialEq, Eq)]
pub enum ExportSource {
    External(SymbolWithSource),
    Internal(Symbol),
}

#[derive(Debug, Serialize, Hash, Clone, PartialEq, Eq)]
pub struct ModuleExport {
    pub source: ExportSource,
    pub exported_name: String,
}

impl ModuleExport {
    pub fn is_internal(&self) -> bool {
        matches!(self.source, ExportSource::Internal(_))
    }

    pub fn is_external(&self) -> bool {
        matches!(self.source, ExportSource::External(_))
    }
}
