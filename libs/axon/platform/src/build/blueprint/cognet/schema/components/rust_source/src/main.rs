use serde_json::{json, Value};
use std::{env, fs, process};
use syn::{GenericArgument, Item, PathArguments, Type, Visibility};

fn main() {
    if let Err(message) = read() {
        eprintln!("{message}");
        process::exit(1);
    }
}

fn read() -> Result<(), String> {
    let path = env::args().nth(1).ok_or("expected a Rust source path")?;
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let source = syn::parse_file(&text).map_err(|error| error.to_string())?;
    let mut shapes = Vec::<Value>::new();
    for item in source.items {
        if matches!(item, Item::Use(_)) { continue; }
        let Item::Struct(shape) = item else {
            return Err("component files may contain only structs and use declarations".into());
        };
        if !shape.generics.params.is_empty() || shape.generics.where_clause.is_some() {
            return Err(format!("{}: generic structs are not component schemas", shape.ident));
        }
        if shape.attrs.iter().any(|attr| !attr.path().is_ident("doc")) {
            return Err(format!("{}: schema attributes are not supported; the file and fields define the component", shape.ident));
        }
        let fields = match shape.fields {
            syn::Fields::Named(fields) => fields.named,
            _ => return Err(format!("{}: expected a struct with named fields", shape.ident)),
        };
        let mut values = Vec::<Value>::new();
        for field in fields {
            let name = field.ident.ok_or("expected a named field")?.to_string();
            if field.attrs.iter().any(|attr| !attr.path().is_ident("doc")) {
                return Err(format!("{}.{}: field attributes are not supported", shape.ident, name));
            }
            if !matches!(field.vis, Visibility::Public(_)) {
                return Err(format!("{}.{}: schema fields must be public", shape.ident, name));
            }
            let (type_name, nullable) = kind(&field.ty)?;
            values.push(json!({ "name": name, "type": type_name, "optional": false, "nullable": nullable }));
        }
        shapes.push(json!({
            "name": shape.ident.to_string(),
            "fields": values,
            "component": matches!(shape.vis, Visibility::Public(_)),
            "doc": doc(&shape.attrs),
        }));
    }
    println!("{}", Value::Array(shapes));
    Ok(())
}

/// A declaration's `///` lines, joined as written: the tags in them say what the component is.
fn doc(attrs: &[syn::Attribute]) -> Option<String> {
    let lines: Vec<String> = attrs.iter().filter_map(|attr| match &attr.meta {
        syn::Meta::NameValue(pair) if pair.path.is_ident("doc") => match &pair.value {
            syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(text), .. }) => Some(text.value().trim().to_string()),
            _ => None,
        },
        _ => None,
    }).collect();
    if lines.is_empty() { None } else { Some(lines.join("\n")) }
}

fn kind(value: &Type) -> Result<(String, bool), String> {
    if let Type::Array(array) = value {
        let syn::Expr::Lit(length) = &array.len else { return Err("Rust component arrays need a literal length".into()); };
        let syn::Lit::Int(length) = &length.lit else { return Err("Rust component arrays need an integer length".into()); };
        let (element, optional) = kind(&array.elem)?;
        if optional { return Err("array elements cannot be Option<T>".into()); }
        return Ok((format!("Fixed<{element},{}>", length.base10_digits()), false));
    }
    let Type::Path(path) = value else { return Err("unsupported Rust field type; use a named type, Option<T>, Vec<T> or a map".into()); };
    if path.qself.is_some() || path.path.segments.len() != 1 {
        return Err("Rust component field types must use unqualified names".into());
    }
    let segment = path.path.segments.first().ok_or("missing Rust type name")?;
    let name = segment.ident.to_string();
    let args = match &segment.arguments {
        PathArguments::None => Vec::new(),
        PathArguments::AngleBracketed(args) => args.args.iter().map(|arg| match arg {
            GenericArgument::Type(inner) => kind(inner).and_then(|(name, optional)| {
                if optional { Err("Option<T> is only supported as a field's outer type".into()) }
                else { Ok(name) }
            }),
            _ => Err("component type arguments must be types".into()),
        }).collect::<Result<Vec<_>, _>>()?,
        _ => return Err(format!("unsupported arguments on {name}")),
    };
    match (name.as_str(), args.as_slice()) {
        ("Option", [_]) => Ok((args[0].clone(), true)),
        ("Vec", [_]) => Ok((format!("Vec<{}>", args[0]), false)),
        ("BTreeMap" | "HashMap", [_, _]) => Ok((format!("Record<{},{}>", args[0], args[1]), false)),
        (_, []) => Ok((match name.as_str() {
            "String" | "str" => "string".into(),
            "bool" => "boolean".into(),
            "f64" | "f32" | "u32" | "i32" => name,
            _ => name,
        }, false)),
        _ => Err(format!("unsupported generic Rust type {name}")),
    }
}
