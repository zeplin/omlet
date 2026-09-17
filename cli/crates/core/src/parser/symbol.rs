use serde::Serialize;
use std::fmt::{self, Display};
use swc_atoms::Atom;
use swc_common::SyntaxContext;
use swc_ecma_ast::{
    Expr, Ident, IdentName, ImportNamedSpecifier, Lit, MemberProp, ModuleExportName,
};

#[derive(Debug, Serialize, Hash, PartialEq, Eq, Clone, PartialOrd, Ord)]
pub enum MemberProperty {
    Array(usize),
    Object(String),
    Invalid,
}

impl Display for MemberProperty {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let str_value = match self {
            MemberProperty::Array(index) => index.to_string(),
            MemberProperty::Object(key) => key.clone(),
            MemberProperty::Invalid => String::from("@invalid"),
        };

        write!(f, "{}", str_value)
    }
}

impl From<&MemberProp> for MemberProperty {
    fn from(value: &MemberProp) -> Self {
        match &value {
            MemberProp::Ident(ident) => MemberProperty::Object(ident.sym.to_string()),
            MemberProp::PrivateName(private_name) => {
                MemberProperty::Object(private_name.name.to_string())
            }
            MemberProp::Computed(computed_prop) => match computed_prop.expr.as_ref() {
                Expr::Lit(literal) => match literal {
                    Lit::Str(str) => {
                        MemberProperty::Object(str.value.to_string_lossy().into_owned())
                    }
                    Lit::Bool(bool) => MemberProperty::Object(bool.value.to_string()),
                    Lit::Null(_) => MemberProperty::Object("null".to_string()),
                    Lit::Num(num) => MemberProperty::Array(num.value as usize),
                    Lit::BigInt(_) => MemberProperty::Invalid,
                    Lit::Regex(_) => MemberProperty::Invalid,
                    Lit::JSXText(_) => MemberProperty::Invalid,
                },
                _ => MemberProperty::Invalid,
            },
        }
    }
}

pub static DEFAULT_EXPORT_NAME: &'static str = "default";
pub static WILDCARD_EXPORT_NAME: &'static str = "<wildcard>";

#[derive(Debug, Hash, PartialEq, Eq, Clone, PartialOrd, Ord)]
pub struct Symbol {
    name: Atom,
    context: SyntaxContext,
}

impl Symbol {
    pub fn new(name: Atom, context: SyntaxContext) -> Self {
        Self { name, context }
    }

    pub fn anonymous(id: u32) -> Self {
        Symbol::from(format!("<anonymous-{}>", id).as_str())
    }

    pub fn wildcard() -> Self {
        Self::new(Atom::from(WILDCARD_EXPORT_NAME), SyntaxContext::empty())
    }

    pub fn eq_name(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name)
    }

    pub fn get_name(&self) -> String {
        self.name.to_string()
    }

    pub fn is_wildcard(&self) -> bool {
        self.name.eq_ignore_ascii_case(WILDCARD_EXPORT_NAME)
    }

    pub fn is_default(&self) -> bool {
        self.name.eq_ignore_ascii_case(DEFAULT_EXPORT_NAME)
    }

    pub fn is_anonymous(&self) -> bool {
        self.name.starts_with("<anonymous")
    }
}

impl Default for Symbol {
    fn default() -> Self {
        Self::new(Atom::from(DEFAULT_EXPORT_NAME), SyntaxContext::empty())
    }
}

impl From<MemberProperty> for Symbol {
    fn from(member_property: MemberProperty) -> Self {
        member_property.to_string().as_str().into()
    }
}

impl From<&Ident> for Symbol {
    fn from(ident: &Ident) -> Self {
        Self::new(ident.sym.clone(), ident.ctxt)
    }
}

impl From<Ident> for Symbol {
    fn from(ident: Ident) -> Self {
        Self::new(ident.sym, ident.ctxt)
    }
}

impl From<&IdentName> for Symbol {
    fn from(ident: &IdentName) -> Self {
        Self::new(ident.sym.clone(), SyntaxContext::empty())
    }
}

impl From<&str> for Symbol {
    fn from(name: &str) -> Self {
        Self::new(Atom::from(name), SyntaxContext::empty())
    }
}

impl From<&ModuleExportName> for Symbol {
    fn from(export_name: &ModuleExportName) -> Self {
        match export_name {
            ModuleExportName::Ident(ident) => Self::from(ident),
            ModuleExportName::Str(str) => Self::new(
                str.value.to_atom_lossy().into_owned(),
                SyntaxContext::empty(),
            ),
        }
    }
}

impl From<&ImportNamedSpecifier> for Symbol {
    fn from(named_specifier: &ImportNamedSpecifier) -> Self {
        if let Some(export_name) = &named_specifier.imported {
            let symbol = Symbol::from(export_name);

            if symbol.is_default() {
                symbol
            } else {
                Self {
                    context: named_specifier.local.ctxt,
                    ..symbol
                }
            }
        } else {
            Symbol::from(&named_specifier.local)
        }
    }
}

impl Serialize for Symbol {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(format!("{}", self).as_str())
    }
}

impl Display for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{:?}", self.name, self.context)
    }
}
