//! Node-ID generation — derived semantic identity contract (deepfield.1).
//!
//! Deepfield derivation `0.1.0-deepfield.1`: this deliberately diverges from
//! the pinned kernel, whose `generateNodeId` parity contract hashed
//! `filePath:kind:name:line`. Same-row, different-column definitions (e.g.
//! `class A { run() {} } class B { run() {} }` on one line) collided; this
//! derivation adds the UTF-16 start column:
//!
//!   `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}:${column}`).hex[0..32]}`
//!
//! The file-node special case is unchanged (the file ID has no column):
//!
//!   `file:${filePath}`
//!
//! `column` is the existing UTF-16 `col_of(node)` (util::col16) — the same
//! unit the reference rows already use, not a new unit. See ADAPTATION.md at
//! the owned derivation root for the full deviation list.

use sha2::{Digest, Sha256};

pub fn node_id(file_path: &str, kind: &str, name: &str, line: u32, column: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    hasher.update(b":");
    hasher.update(kind.as_bytes());
    hasher.update(b":");
    hasher.update(name.as_bytes());
    hasher.update(b":");
    hasher.update(line.to_string().as_bytes());
    hasher.update(b":");
    hasher.update(column.to_string().as_bytes());
    let digest = hasher.finalize();
    // 32 hex chars = first 16 bytes.
    let mut hex = String::with_capacity(kind.len() + 1 + 32);
    hex.push_str(kind);
    hex.push(':');
    for b in &digest[..16] {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

pub fn file_node_id(file_path: &str) -> String {
    format!("file:{file_path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_pinned_five_component_vector() {
        // Pinned vector, computed independently with Node crypto:
        //   node -e "crypto.createHash('sha256')
        //     .update('src/a.ts:function:foo:3:5').digest('hex').substring(0,32)"
        assert_eq!(
            node_id("src/a.ts", "function", "foo", 3, 5),
            "function:fe90b7af9c8dc6589e2ac23f838ad1db"
        );
    }

    #[test]
    fn different_column_differs() {
        // Same file/kind/name/line, different UTF-16 column: IDs MUST differ —
        // the collision this derivation fixes (`class A { run() {} }` vs
        // `class B { run() {} }` on the same line, columns 10/31).
        assert_ne!(
            node_id("src/a.ts", "method", "run", 1, 10),
            node_id("src/a.ts", "method", "run", 1, 31)
        );
    }

    #[test]
    fn file_node_id_unchanged() {
        // The file-node special case carries no column component.
        assert_eq!(file_node_id("src/a.ts"), "file:src/a.ts");
    }
}