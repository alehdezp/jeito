//! Pinned local encoding shared by maintenance and admitted discovery.
//! No model acquisition, index mutation, or alternate provider lives here.
use std::fs::File;
use std::io::Read;
use std::path::Path;

use model2vec_rs::model::StaticModel;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::dispatch::{NativeError, OperationContext};
use crate::output::ToolOutput;

pub(crate) const REPRESENTATION: &str = "codeweave-pi-code-input-v1";
const ASSETS: [(&str, u64, &str); 3] = [
    ("config.json", 59, "148e5691a6fcc553437156859701fba017a1ba5d340b170f17e0f3668fb861a7"),
    ("tokenizer.json", 1_024_340, "107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45"),
    ("model.safetensors", 32_490_072, "75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c"),
];

fn recipe_descriptor() -> Value {
    json!(["codeweave-pi-semantic-recipe-v1", ["model2vec-rs", "0.2.1"], ASSETS,
        ["tokenizer", "padding-disabled", "truncation-disabled", "special-tokens-disabled"],
        ["encode", null, 1, "normalization-explicit-true", "model2vec-0.2.1-pooling-and-unknown-token-filter"],
        ["output", DIMENSIONS, "f32-le", "finite", "abs(sum-squares-1)<0.001"],
        ["representation", REPRESENTATION, "compact-serde-json-seven-string-array", "verbatim-source-fields",
         "tsjs-named-body-class-interface-namespace-subtraction", "legacy-unique-outline-child-subtraction"],
        ["query", "verbatim-utf8"]])
}

pub(crate) fn recipe() -> &'static str {
    static DIGEST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DIGEST.get_or_init(|| format!("{:x}", Sha256::digest(recipe_descriptor().to_string().as_bytes())))
}
pub(crate) const DIMENSIONS: usize = 256;
pub(crate) const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_BATCH: usize = 16;

fn asset(directory: &Path, name: &str, size: u64, digest: &str) -> Result<Vec<u8>, String> {
    let file = File::open(directory.join(name)).map_err(|error| format!("local model {name}: {error}"))?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err(format!("local model {name} is not a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(size + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(format!("local model {name} does not match the selected recipe"));
    }
    Ok(bytes)
}

pub(crate) fn encode(directory: &Path, texts: &[String], context: &OperationContext) -> Result<Vec<Vec<f32>>, String> {
    context.check().map_err(|error| error.to_string())?;
    if !directory.is_absolute() || texts.is_empty() || texts.len() > MAX_BATCH
        || texts.iter().any(|text| text.len() > MAX_TEXT_BYTES)
    {
        return Err("local encoding requires an absolute asset directory, 1-16 inputs and at most 64 KiB per input".into());
    }
    let load = |index: usize| { let (name, size, digest) = ASSETS[index]; asset(directory, name, size, digest) };
    let config = load(0)?;
    let tokenizer = load(1)?;
    let weights = load(2)?;
    context.check().map_err(|error| error.to_string())?;
    let mut tokenizer: Value = serde_json::from_slice(&tokenizer).map_err(|error| error.to_string())?;
    // Pooling includes padding IDs and has a second independent length default.
    // Clear both tokenizer settings AND pass None to encode_with_args.
    tokenizer["padding"] = Value::Null;
    tokenizer["truncation"] = Value::Null;
    let model = StaticModel::from_bytes(serde_json::to_vec(&tokenizer).map_err(|error| error.to_string())?, weights, config, Some(true))
        .map_err(|error| error.to_string())?;
    let mut vectors = Vec::with_capacity(texts.len());
    for text in texts {
        context.check().map_err(|error| error.to_string())?;
        let vector = model.encode_with_args(std::slice::from_ref(text), None, 1)
            .pop().ok_or("encoder returned no vector")?;
        if !valid_vector(&vector) {
            return Err("encoder returned an empty, nonfinite, or incompatible vector".into());
        }
        vectors.push(vector);
    }
    context.check().map_err(|error| error.to_string())?;
    Ok(vectors)
}

pub(crate) fn valid_vector(vector: &[f32]) -> bool {
    if vector.len() != DIMENSIONS || vector.iter().any(|value| !value.is_finite()) {
        return false;
    }
    let norm: f64 = vector.iter().map(|value| f64::from(*value).powi(2)).sum();
    (norm - 1.0).abs() < 0.001
}

pub(crate) fn decode_vector(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() != DIMENSIONS * 4 {
        return Err("semantic vector has incompatible dimensions".into());
    }
    let vector = bytes.chunks_exact(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])).collect::<Vec<_>>();
    if !valid_vector(&vector) {
        return Err("semantic vector is not finite and normalized".into());
    }
    Ok(vector)
}

#[cfg(feature = "napi-addon")]
pub(crate) fn encode_operation(arguments: &Value, context: &OperationContext) -> Result<ToolOutput, NativeError> {
    let directory = arguments["modelDirectory"].as_str().ok_or_else(|| NativeError::invalid_argument("modelDirectory is required"))?;
    let texts: Vec<String> = serde_json::from_value(arguments["texts"].clone())
        .map_err(|error| NativeError::invalid_argument(error.to_string()))?;
    let vectors = encode(Path::new(directory), &texts, context).map_err(NativeError::Domain)?;
    Ok(ToolOutput::complete("pi_nav_semantic_encode", String::new(),
        json!({"recipe":recipe(),"dimensions":DIMENSIONS,"vectors":vectors}), texts.len(), texts.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{NativeSession, ReadFormat};

    #[test]
    fn invalid_vectors_and_resource_requests_fail_before_model_loading() {
        assert!(decode_vector(&[0; 4]).is_err());
        assert!(decode_vector(&[0; DIMENSIONS * 4]).is_err());
        let mut vector = vec![0.0_f32; DIMENSIONS];
        vector[0] = 1.0;
        let bytes = vector.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
        assert_eq!(decode_vector(&bytes).unwrap(), vector);
        vector[0] = f32::NAN;
        assert!(!valid_vector(&vector));
        let temp = tempfile::tempdir().unwrap();
        let session = NativeSession::new(temp.path(), false).unwrap();
        let context = OperationContext::for_session(&session, ReadFormat::Plain, true);
        assert!(encode(temp.path(), &["x".repeat(MAX_TEXT_BYTES + 1)], &context).unwrap_err().contains("64 KiB"));
        assert!(encode(temp.path(), &vec!["x".into(); MAX_BATCH + 1], &context).unwrap_err().contains("1-16"));
    }
}

pub(crate) struct InputOwner {
    pub(crate) id: String,
    pub(crate) kind: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

impl InputOwner {
    pub(crate) fn span(&self, text: &str) -> Option<std::ops::Range<usize>> {
        let start = crate::search::prepared::byte_at(text, self.start_line, self.start_column).ok()?;
        let end = crate::search::prepared::byte_at(text, self.end_line, self.end_column).ok()?;
        (start < end).then_some(start..end)
    }
}

pub(crate) fn input_projection(arguments: &Value, path: &str, text: &str, context: &OperationContext) -> Result<Value, String> {
    let raw = arguments["owners"].as_array().ok_or("owners must be an array")?;
    if raw.len() > MAX_BATCH { return Err("at most 16 owners per projection".into()); }
    let mut owners = Vec::with_capacity(raw.len());
    let mut seen = std::collections::HashSet::new();
    // Validate before cloning/deserializing: malformed values must not be echoed
    // into an unbounded error or allocate a second copy of arbitrary payloads.
    for owner in raw {
        let fields = owner.as_object().ok_or("owner must be an object")?;
        if fields.len() != 6 || fields.keys().any(|key| !["id", "kind", "startLine", "startColumn", "endLine", "endColumn"].contains(&key.as_str())) {
            return Err("owner requires exactly id, kind and four source coordinates".into());
        }
        let id = owner["id"].as_str().ok_or("owner ID must be a string")?;
        let kind = owner["kind"].as_str().ok_or("owner kind must be a string")?;
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)
            || kind.is_empty() || kind.len() > 64 || kind.chars().any(char::is_control) || !seen.insert(id) {
            return Err("owner IDs must be unique nonempty bounded strings (256 bytes); kinds at most 64 bytes".into());
        }
        let coordinate = |key: &str| owner[key].as_u64().and_then(|value| u32::try_from(value).ok())
            .ok_or("owner coordinates must be unsigned 32-bit integers");
        owners.push(InputOwner { id: id.into(), kind: kind.into(), start_line: coordinate("startLine")?,
            start_column: coordinate("startColumn")?, end_line: coordinate("endLine")?, end_column: coordinate("endColumn")? });
    }
    let projected = crate::search::fuzzy::project_semantic_inputs(path, text, &owners, context)?;
    Ok(json!({"recipe":recipe(),"dimensions":DIMENSIONS,"representation":REPRESENTATION,"owners":projected}))
}
