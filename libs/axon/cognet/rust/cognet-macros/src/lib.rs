//! `#[system]` — a Rust function declared as a cognet system.
//!
//! ```ignore
//! #[system(on = [clock], reads = [A], streams = [E], recalls = [B], writes = [C, D], uses = ["depth"], thread = "worker", lag = 2)]
//! fn strike(run: &mut Run) -> Result<(), Fault> { ... }
//! ```
//!
//! Keeps the function as written and adds, beside it, the two things the
//! generated module calls every system by, whatever its function is named:
//! `__cognet_declare()` — the declaration, by name — and `__COGNET_BODY`, how
//! it runs. An `async fn` runs beside the tick, in a conversation with the
//! host, and may ask the kernel things; a plain `fn` runs in the tick.
//! A file holds one system, as a `.system.ts` does; its name is its path.

use proc_macro::TokenStream;
use std::collections::HashSet;
use quote::quote;
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::{bracketed, parse_macro_input, Expr, FnArg, Ident, ItemFn, Lit, LitInt, LitStr, Pat, Token};

#[proc_macro_attribute]
pub fn system(attribute: TokenStream, item: TokenStream) -> TokenStream {
    let declared = parse_macro_input!(attribute as Declared);
    let mut function = parse_macro_input!(item as ItemFn);
    let name = &function.sig.ident;

    let list = |items: &[Expr]| {
        let names = items.iter().map(|item| match item {
            Expr::Lit(literal) if matches!(literal.lit, Lit::Str(_)) => quote! { #item },
            _ => quote! { ::cognet::Named::name(&#item) },
        });
        quote! { vec![#(#names),*] }
    };
    let reads = list(&declared.reads);
    let streams = list(&declared.streams);
    let recalls = list(&declared.recalls);
    let writes = list(&declared.writes);
    let uses = declared.uses.iter().map(|one| quote! { #one });
    let uses = quote! { vec![#(#uses),*] };
    let on = match &declared.on {
        Some(items) => {
            let items = list(items);
            quote! { Some(#items) }
        }
        None => quote! { None },
    };
    let once = declared.once;
    let thread = match &declared.thread {
        Some(value) => quote! { Some(#value) },
        None => quote! { None },
    };
    let lag = match &declared.lag {
        Some(value) => quote! { Some(#value) },
        None => quote! { None },
    };
    let run_arg = match function.sig.inputs.first() {
        Some(FnArg::Typed(arg)) => match arg.pat.as_ref() {
            Pat::Ident(ident) => ident.ident.clone(),
            _ => return syn::Error::new_spanned(arg, "a system's Run parameter needs a name").to_compile_error().into(),
        },
        _ => return syn::Error::new_spanned(&function.sig, "a system needs a &mut Run parameter").to_compile_error().into(),
    };
    function.block.stmts.insert(0, syn::parse_quote! { let ecs = &mut #run_arg.ecs; });
    let asynchronous = function.sig.asyncness.is_some();
    if asynchronous && declared.thread.is_some() {
        return syn::Error::new_spanned(&function.sig, "an async system runs beside the tick, never on a worker").to_compile_error().into();
    }

    let body = if asynchronous {
        quote! {
            /// One run of this system: its future, borrowing the run.
            pub fn __cognet_run<'a>(run: &'a mut ::cognet::Run) -> ::core::pin::Pin<::std::boxed::Box<dyn ::core::future::Future<Output = ::core::result::Result<(), ::cognet::Fault>> + 'a>> {
                ::std::boxed::Box::pin(#name(run))
            }

            /// How this system runs: beside the tick, in a conversation with the host.
            pub const __COGNET_BODY: ::cognet::Body = ::cognet::Body::Async(__cognet_run);
        }
    } else {
        quote! {
            /// One run of this system.
            pub fn __cognet_run(run: &mut ::cognet::Run) -> ::core::result::Result<(), ::cognet::Fault> {
                #name(run)
            }

            /// How this system runs: in the tick.
            pub const __COGNET_BODY: ::cognet::Body = ::cognet::Body::Sync(__cognet_run);
        }
    };

    quote! {
        #function

        /// This system's declaration, by name — what the build hands the schedule.
        pub fn __cognet_declare() -> ::cognet::Declaration {
            ::cognet::Declaration { on: #on, reads: #reads, streams: #streams, recalls: #recalls, writes: #writes, uses: #uses, once: #once, thread: #thread, lag: #lag, asynchronous: #asynchronous }
        }

        #body
    }
    .into()
}

/// What `#[system(...)]` says: lists of handles, a flag, a thread, and a lag.
struct Declared {
    on: Option<Vec<Expr>>,
    reads: Vec<Expr>,
    streams: Vec<Expr>,
    recalls: Vec<Expr>,
    writes: Vec<Expr>,
    /// The services it calls, by the names the cognet gave them.
    uses: Vec<LitStr>,
    once: bool,
    thread: Option<LitStr>,
    lag: Option<LitInt>,
}

impl Parse for Declared {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let mut declared = Declared { on: None, reads: Vec::new(), streams: Vec::new(), recalls: Vec::new(), writes: Vec::new(), uses: Vec::new(), once: false, thread: None, lag: None };
        let mut seen = HashSet::new();
        while !input.is_empty() {
            let key: Ident = input.parse()?;
            if !seen.insert(key.to_string()) {
                return Err(syn::Error::new(key.span(), format!("duplicate #[system] field {key}")));
            }
            match key.to_string().as_str() {
                "once" => declared.once = true,
                "thread" => {
                    input.parse::<Token![=]>()?;
                    let value: LitStr = input.parse()?;
                    if value.value() != "worker" {
                        return Err(syn::Error::new(value.span(), "a system's thread is \"worker\", or it runs on the main thread"));
                    }
                    declared.thread = Some(value);
                }
                "lag" => {
                    input.parse::<Token![=]>()?;
                    let value: LitInt = input.parse()?;
                    value.base10_parse::<u32>().map_err(|_| syn::Error::new(value.span(), "a lag is a whole number of ticks"))?;
                    declared.lag = Some(value);
                }
                "uses" => {
                    input.parse::<Token![=]>()?;
                    let content;
                    bracketed!(content in input);
                    declared.uses = Punctuated::<LitStr, Token![,]>::parse_terminated(&content)?.into_iter().collect();
                }
                "on" | "reads" | "streams" | "recalls" | "writes" => {
                    input.parse::<Token![=]>()?;
                    let content;
                    bracketed!(content in input);
                    let items: Vec<Expr> = Punctuated::<Expr, Token![,]>::parse_terminated(&content)?.into_iter().collect();
                    match key.to_string().as_str() {
                        "on" => declared.on = Some(items),
                        "reads" => declared.reads = items,
                        "streams" => declared.streams = items,
                        "recalls" => declared.recalls = items,
                        _ => declared.writes = items,
                    }
                }
                other => return Err(syn::Error::new(key.span(), format!("#[system] says on, reads, streams, recalls, writes, uses, once, thread or lag — not {other}"))),
            }
            if !input.is_empty() {
                input.parse::<Token![,]>()?;
            }
        }
        Ok(declared)
    }
}
