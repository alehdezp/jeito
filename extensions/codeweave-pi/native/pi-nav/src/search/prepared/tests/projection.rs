use super::*;

fn arguments(fixture: &IndexedFixture, operation: &str, query: &str) -> Value {
    let mut args = fixture.ordinary_arguments();
    args.as_object_mut().unwrap().remove("retainRankedRender");
    args["query"] = json!(query);
    args["analysisProjection"] = json!({"operation":operation});
    args
}
fn data(fixture: &IndexedFixture, operation: &str, query: &str) -> Value {
    fixture.call(&arguments(fixture, operation, query)).unwrap().structured["data"].clone()
}
fn ids(data: &Value, key: &str) -> Vec<String> {
    data[key].as_array().unwrap().iter().map(|node| node["id"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn projection_source_versions_are_raw_captured_bytes_and_follow_transport_selection() {
    let fixture = IndexedFixture::new();
    let text = "function Wanted() { return 7; }\r\n";
    std::fs::write(fixture.context.root.join("target.ts"), text).unwrap();
    let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
    fixture.connection.execute("UPDATE files SET content_hash=?1 WHERE path='target.ts'", [&digest]).unwrap();
    let result = data(&fixture, "callers", "Wanted");
    let claims = result["source_claims"].as_array().unwrap();
    assert_eq!(claims.len(), 2);
    assert!(claims.contains(&json!({"path":"target.ts","raw_digest":digest})));
    assert_ne!(digest, format!("{:x}", Sha256::digest(text.replace("\r\n", "\n").as_bytes())));
    assert!(!claims.iter().any(|claim| claim["path"] == "unrelated.ts"));
    std::fs::write(fixture.context.root.join("target.ts"), text.replace('7', "8")).unwrap();
    assert!(fixture.call(&arguments(&fixture, "callers", "Wanted")).is_err(), "stale source must not gain a version claim");

    let fixture = IndexedFixture::new();
    fixture.connection.execute("UPDATE nodes SET qualified_name=?1 WHERE id='Unrelated'", ["Z".repeat(300_000)]).unwrap();
    fixture.connection.execute("INSERT INTO edges VALUES (2,'Wanted','Unrelated','calls',1,0,'{}',NULL)", []).unwrap();
    let output = fixture.call(&arguments(&fixture, "traverse", "Wanted")).unwrap();
    assert!(serde_json::to_vec(&output.structured).unwrap().len() + output.text.len() + 1024 <= 256 * 1024);
    let result = &output.structured["data"];
    assert!(result["coverage"]["reasons"].as_array().unwrap().contains(&json!("projection_byte_cap")));
    assert!(!ids(result, "nodes").contains(&"Unrelated".to_owned()));
    assert!(!result["source_claims"].as_array().unwrap().iter().any(|claim| claim["path"] == "unrelated.ts"), "dropped file versions are not returned");
}

#[test]
fn projection_depth_includes_induced_frontier_and_parallel_edges_once() {
    let fixture = IndexedFixture::new();
    fixture.connection.execute_batch("INSERT INTO edges VALUES
        (2,'Wanted','Unrelated','calls',1,0,'{}','resolution'),
        (3,'Caller','Unrelated','references',1,0,'{}','resolution'),
        (4,'Caller','Wanted','calls',1,27,'{}','resolution');").unwrap();
    let mut args = arguments(&fixture, "traverse", "Wanted");
    args["analysisProjection"]["depth"] = json!(1);
    let result = fixture.call(&args).unwrap();
    let data = &result.structured["data"];
    assert_eq!(data["status"], "ok");
    assert_eq!(ids(data, "nodes"), ["Wanted", "Caller", "Unrelated"]);
    assert_eq!(data["edges"].as_array().unwrap().len(), 4);
    let edge_ids = data["edges"].as_array().unwrap().iter().map(|edge| edge["id"].as_i64().unwrap()).collect::<HashSet<_>>();
    assert_eq!(edge_ids, HashSet::from([1,2,3,4]), "frontier-to-frontier and parallel records survive");
    assert_eq!(data["nodes"][1]["depth"], 1);
    assert_eq!(data["coverage"]["complete"], true);
    assert_eq!(data["analysis"]["indexedRunId"], fixture.status()["runId"]);
    assert!(data["analysis"].get("generation").is_none());
    assert!(data["edges"].as_array().unwrap().iter().all(|edge| edge.get("metadata").is_none() && edge.get("provenance").is_none()));
}

#[test]
fn projection_depth_scope_and_kind_are_selection_boundaries() {
    let fixture = IndexedFixture::new();
    fixture.connection.execute("INSERT INTO edges VALUES (2,'Unrelated','Caller','calls',1,0,'{}',NULL)", []).unwrap();
    let mut args = arguments(&fixture, "traverse", "Wanted");
    args["analysisProjection"]["depth"] = json!(1);
    assert_eq!(ids(&fixture.call(&args).unwrap().structured["data"], "nodes"), ["Wanted", "Caller"]);
    args["analysisProjection"]["depth"] = json!(2);
    assert_eq!(ids(&fixture.call(&args).unwrap().structured["data"], "nodes"), ["Wanted", "Caller", "Unrelated"]);
    args["scope"] = json!(fixture.context.root.join("target.ts"));
    let scoped = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(ids(&scoped, "nodes"), ["Wanted"]);
    assert!(scoped["edges"].as_array().unwrap().is_empty());
    args["scope"] = json!(fixture.context.root);
    fixture.connection.execute("UPDATE nodes SET kind='method' WHERE id='Caller'", []).unwrap();
    args["analysisProjection"]["nodeKinds"] = json!(["function"]);
    assert_eq!(ids(&fixture.call(&args).unwrap().structured["data"], "nodes"), ["Wanted"], "excluded intermediates are not silently traversed");
}

#[test]
fn projection_exact_identity_ambiguity_and_file_seeds_do_not_guess() {
    let fixture = IndexedFixture::new();
    fixture.connection.execute_batch("UPDATE nodes SET name='Same',qualified_name='Scope.Same' WHERE id='Wanted';
        UPDATE nodes SET name='Same',qualified_name='Other.Same' WHERE id='Unrelated';
        INSERT INTO nodes SELECT 'file-target','file','target.ts','target.ts',file_path,start_line,end_line,start_column,end_column FROM nodes WHERE id='Wanted';
        INSERT INTO edges VALUES (2,'file-target','Wanted','contains',NULL,NULL,NULL,NULL);").unwrap();
    let ambiguous = data(&fixture, "traverse", "Same");
    assert_eq!(ambiguous["status"], "ambiguous");
    assert_eq!(ambiguous["candidates"].as_array().unwrap().len(), 2);
    assert!(ambiguous["nodes"].as_array().unwrap().is_empty());
    assert!(ambiguous["edges"].as_array().unwrap().is_empty());
    for query in ["Wanted", "Scope.Same", "target.ts::Same"] {
        assert_eq!(data(&fixture, "traverse", query)["roots"], json!(["Wanted"]), "{query}");
    }
    let absolute = format!("{}::Same", fixture.context.root.join("target.ts").display());
    assert_eq!(data(&fixture, "traverse", &absolute)["roots"], json!(["Wanted"]));
    assert_eq!(data(&fixture, "traverse", "target.ts")["roots"], json!(["file-target"]));
    assert_eq!(data(&fixture, "traverse", "NotThere")["status"], "not_found");
    let mut args = arguments(&fixture, "traverse", "scope.same");
    args["case"] = json!("insensitive");
    assert_eq!(fixture.call(&args).unwrap().structured["data"]["roots"], json!(["Wanted"]));
}

#[test]
fn projection_relations_keep_direction_function_values_and_parallel_records() {
    let fixture = IndexedFixture::new();
    fixture.connection.execute_batch("INSERT INTO edges VALUES
        (2,'Wanted','Unrelated','calls',1,0,'{}',NULL),
        (3,'Unrelated','Wanted','references',1,0,'{\"fnRef\":true}',NULL),
        (4,'Caller','Wanted','calls',1,27,'{}',NULL),
        (5,'Caller','Wanted','references',1,0,'{}',NULL);").unwrap();
    let incoming = data(&fixture, "callers", "Wanted");
    let edge_ids = incoming["edges"].as_array().unwrap().iter().map(|edge| edge["id"].as_i64().unwrap()).collect::<Vec<_>>();
    assert_eq!(edge_ids, [1,4,3]);
    assert_eq!(incoming["edges"][2]["functionReference"], true);
    assert_eq!(incoming["edges"][0]["line"], 1);
    let outgoing = data(&fixture, "callees", "Wanted");
    assert_eq!(outgoing["edges"].as_array().unwrap().len(), 1);
    assert_eq!(outgoing["edges"][0]["id"], 2);
    assert_eq!(outgoing["edges"][0]["target"], "Unrelated");
    // Invalid positions are withheld without deleting the relationship.
    fixture.connection.execute("UPDATE edges SET line=999 WHERE id=2", []).unwrap();
    let outgoing = data(&fixture, "callees", "Wanted");
    assert!(outgoing["edges"][0]["line"].is_null());
    assert!(outgoing["edges"][0]["column"].is_null());
}

#[test]
fn projection_returns_stable_full_collection_for_wrapper_numbered_pages() {
    let fixture = IndexedFixture::new();
    for id in 2..=125 {
        fixture.connection.execute("INSERT INTO edges VALUES (?1,'Caller','Wanted','calls',1,27,'{}',NULL)", [id]).unwrap();
    }
    let first = data(&fixture, "callers", "Wanted");
    let second = data(&fixture, "callers", "Wanted");
    assert_eq!(first, second);
    assert_eq!(first["edges"].as_array().unwrap().len(), 125, "no hidden first-page SQL cap");
    assert_eq!(first["analysis"]["continuationStatus"], "wrapper-numbered-pages");
    let mut args = arguments(&fixture, "callers", "Wanted");
    args["page"] = json!(2);
    assert!(fixture.call(&args).unwrap_err().contains("does not accept page"));
    args.as_object_mut().unwrap().remove("page");
    args["analysisRunId"] = first["analysis"]["indexedRunId"].clone();
    assert!(fixture.call(&args).is_ok());
    let mut status = fixture.status();
    status["runId"] = json!("22222222-2222-4222-8222-222222222222");
    fixture.write_status(status);
    assert!(fixture.call(&args).unwrap_err().contains("completed indexed run does not match"));
}

#[test]
fn projection_caps_are_explicit_without_dangling_edges() {
    let fixture = IndexedFixture::new();
    for index in 0..1002 {
        let id = format!("copy-{index:04}");
        fixture.connection.execute("INSERT INTO nodes SELECT ?1,kind,?1,?1,file_path,start_line,end_line,start_column,end_column FROM nodes WHERE id='Caller'", [&id]).unwrap();
        fixture.connection.execute("INSERT INTO edges(source,target,kind,line,col) VALUES (?1,'Wanted','calls',1,27)", [&id]).unwrap();
    }
    let output = fixture.call(&arguments(&fixture, "callers", "Wanted")).unwrap();
    assert!(serde_json::to_vec(&output.structured).unwrap().len() + output.text.len() + 1024 <= 256 * 1024);
    let result = output.structured["data"].clone();
    assert!((2..1000).contains(&result["nodes"].as_array().unwrap().len()));
    assert!(!result["edges"].as_array().unwrap().is_empty(), "transport fitting preserves relationships, not just endpoints");
    assert!(result["coverage"]["reasons"].as_array().unwrap().contains(&json!("node_cap")));
    let kept = ids(&result, "nodes").into_iter().collect::<HashSet<_>>();
    assert!(result["edges"].as_array().unwrap().iter().all(|edge| kept.contains(edge["source"].as_str().unwrap()) && kept.contains(edge["target"].as_str().unwrap())));
    let fixture = IndexedFixture::new();
    for id in 2..=4002 {
        fixture.connection.execute("INSERT INTO edges VALUES (?1,'Caller','Wanted','calls',1,27,'{}',NULL)", [id]).unwrap();
    }
    let output = fixture.call(&arguments(&fixture, "callers", "Wanted")).unwrap();
    assert!(serde_json::to_vec(&output.structured).unwrap().len() + output.text.len() + 1024 <= 256 * 1024);
    let result = output.structured["data"].clone();
    assert!((1..4000).contains(&result["edges"].as_array().unwrap().len()));
    assert_eq!(result["nodes"].as_array().unwrap().len(), 2);
    assert!(result["coverage"]["reasons"].as_array().unwrap().contains(&json!("edge_cap")));
}

#[test]
fn projection_search_reuses_lexical_identity_without_requiring_optional_model() {
    let fixture = IndexedFixture::new();
    let result = data(&fixture, "search", "Wanted");
    assert!(ids(&result, "nodes").contains(&"Wanted".to_owned()));
    assert_eq!(result["analysis"]["semantic"]["status"], "unavailable");
    assert_eq!(result["coverage"]["complete"], false);
    assert!(result["edges"].as_array().unwrap().is_empty());
    let mut args = arguments(&fixture, "search", "Wanted");
    args["analysisProjection"]["nodeKinds"] = json!(["class"]);
    assert!(fixture.call(&args).unwrap().structured["data"]["nodes"].as_array().unwrap().is_empty());
    fixture.connection.execute("INSERT INTO nodes SELECT 'file-target','file','target.ts','target.ts',file_path,start_line,end_line,start_column,end_column FROM nodes WHERE id='Wanted'", []).unwrap();
    args["query"] = json!("target");
    args["analysisProjection"]["nodeKinds"] = json!(["file"]);
    let result = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(ids(&result, "nodes"), ["file-target"]);
    assert_eq!(result["coverage"]["complete"], true);
}

#[test]
fn projection_fails_closed_on_status_source_admission_and_excluded_rows() {
    for operation in ["search", "traverse", "callers", "callees"] {
        let fixture = IndexedFixture::new();
        let mut status = fixture.status(); status["state"] = json!("building"); fixture.write_status(status);
        assert!(fixture.call(&arguments(&fixture, operation, "Wanted")).is_err(), "{operation}");
        fixture.write_status(fixture.status());
        std::fs::write(fixture.context.root.join("target.ts"), "function Wanted() { return 8; }\n").unwrap();
        assert!(fixture.call(&arguments(&fixture, operation, "Wanted")).is_err(), "stale {operation}");
    }
    let fixture = IndexedFixture::new();
    let mut args = arguments(&fixture, "traverse", "Wanted");
    args["analysisPolicyDigest"] = json!("b".repeat(64));
    assert!(fixture.call(&args).unwrap_err().contains("policy"));
    fixture.connection.execute("INSERT INTO nodes VALUES ('excluded','function','SECRET','SECRET','excluded.ts',1,1,0,1)", []).unwrap();
    assert!(fixture.call(&arguments(&fixture, "traverse", "Wanted")).unwrap_err().contains("ineligible paths"));
}

#[test]
fn projection_rejects_mixed_modes_unsupported_kind_and_preserves_ranked_route() {
    let fixture = IndexedFixture::new();
    for (key, value) in [("cursor", json!("fake")), ("retainRankedRender", json!(true)), ("visibility", json!("all")), ("output", json!("matches")), ("analysisRevision", json!("test-analysis"))] {
        let mut args = arguments(&fixture, "traverse", "Wanted"); args[key] = value;
        assert!(fixture.call(&args).is_err(), "{key}");
    }
    for projection in [json!({"operation":"traverse","depth":7}), json!({"operation":"callees","depth":2}), json!({"operation":"search","nodeKinds":["Test"]}), json!({"operation":"tests"})] {
        let mut args = arguments(&fixture, "traverse", "Wanted"); args["analysisProjection"] = projection;
        assert!(fixture.call(&args).is_err());
    }
    let ranked = fixture.call(&fixture.ordinary_arguments()).unwrap();
    assert_ne!(ranked.structured["data"]["mode"], "analysis_projection");
    assert!(ranked.text.contains("Wanted"));
}

#[test]
fn projection_exact_seeds_bypass_scan_cap_and_unknown_tails_never_become_unique_or_absent() {
    let fixture = IndexedFixture::new();
    fixture.connection.execute_batch("BEGIN;
        WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM copies WHERE n<20001)
        INSERT INTO nodes SELECT 'noise-'||n,'function','Noise','Noise','caller.ts',1,1,0,36 FROM copies;
        COMMIT;").unwrap();
    let exact = data(&fixture, "callees", "Wanted");
    assert_eq!(exact["roots"], json!(["Wanted"]));
    assert_eq!(exact["coverage"]["complete"], true);
    let unexamined = data(&fixture, "callees", "wanted");
    assert_eq!(unexamined["status"], "incomplete");
    assert!(unexamined["coverage"]["reasons"].as_array().unwrap().contains(&json!("seed_scan_cap")));
    assert!(unexamined["roots"].as_array().unwrap().is_empty());
    fixture.connection.execute("UPDATE nodes SET qualified_name=?1 WHERE id='Wanted'", ["Q".repeat(1024*1024)]).unwrap();
    let oversized = data(&fixture, "callees", "Wanted");
    assert_eq!(oversized["status"], "incomplete");
    assert!(oversized["coverage"]["reasons"].as_array().unwrap().contains(&json!("projection_byte_cap")));
    assert!(oversized["roots"].as_array().unwrap().is_empty());
}

#[test]
fn projection_search_retains_producer_semantic_coverage_and_same_run_identity_without_encoding() {
    let fixture = IndexedFixture::new(); fixture.enable_semantics();
    let mut descriptor = fixture.semantic_descriptor();
    descriptor["status"] = json!("unavailable"); descriptor["reason"] = json!("budget");
    descriptor["examined"] = json!(0); descriptor["unexamined"] = json!(3);
    descriptor["represented"] = json!(0); descriptor["unrepresented"] = json!(3);
    fixture.set_semantics(descriptor.clone());
    let result = data(&fixture, "search", "Wanted");
    assert!(ids(&result, "nodes").contains(&"Wanted".to_owned()));
    assert_eq!(result["analysis"]["semantic"]["preparation"], descriptor);
    assert_eq!(result["analysis"]["semantic"]["indexedRunId"], result["analysis"]["indexedRunId"]);
    assert_eq!(result["analysis"]["semantic"]["indexedStatusDigest"], result["analysis"]["indexedStatusDigest"]);
    assert_eq!(result["coverage"]["complete"], false);
}

fn add_current_source(fixture: &mut IndexedFixture, file: &str, id: &str, text: &str, start: u32, indexed: bool) {
    let path = fixture.context.root.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
    fixture.arguments["corpusAdmission"]["files"].as_array_mut().unwrap().push(json!(file));
    if indexed {
        fixture.connection.execute("INSERT INTO files VALUES (?1,?2,NULL)", rusqlite::params![file, format!("{:x}", Sha256::digest(text.as_bytes()))]).unwrap();
        let end = text.lines().count() as u32;
        let column = text.lines().last().unwrap().encode_utf16().count() as u32;
        fixture.connection.execute("INSERT INTO nodes VALUES (?1,'function',?1,?1,?2,?3,?4,0,?5)", rusqlite::params![id,file,start,end,column]).unwrap();
    }
    fixture.write_status(fixture.status());
}

#[test]
fn projection_test_paths_use_existing_heuristic_and_explicit_lexical_filter() {
    let mut fixture = IndexedFixture::new();
    add_current_source(&mut fixture, "tests/wanted.ts", "WantedSpec", "function WantedSpec() { return Wanted(); }\n", 1, true);
    add_current_source(&mut fixture, "wanted_test.rs", "wanted_test", "#[test]\nfn wanted_test() { assert!(true); }\n", 2, true);
    fixture.connection.execute("INSERT INTO edges VALUES (2,'WantedSpec','Wanted','calls',1,0,NULL,NULL)", []).unwrap();
    let ordinary = data(&fixture, "search", "wanted");
    assert!(!ids(&ordinary, "nodes").contains(&"WantedSpec".into()));
    assert!(!ids(&ordinary, "nodes").contains(&"wanted_test".into()));
    let mut args = arguments(&fixture, "search", "wanted");
    args["analysisProjection"]["testOnly"] = json!(true);
    let tests = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(ids(&tests, "nodes").into_iter().collect::<HashSet<_>>(), HashSet::from(["WantedSpec".into(),"wanted_test".into()]));
    assert!(tests["nodes"].as_array().unwrap().iter().all(|node| node["isTestFile"] == true && node["kind"] == "function"));
    assert_eq!(tests["analysis"]["semantic"]["status"], "unavailable");
    let callers = data(&fixture, "callers", "Wanted");
    assert!(callers["nodes"].as_array().unwrap().iter().any(|node| node["id"] == "WantedSpec" && node["isTestFile"] == true));
    assert!(callers["nodes"].as_array().unwrap().iter().any(|node| node["id"] == "Caller" && node["isTestFile"] == false));
}

#[test]
fn projection_impact_is_current_file_seeded_reverse_reachability_not_risk() {
    let fixture = IndexedFixture::new();
    fixture.connection.execute_batch("INSERT INTO edges VALUES
        (2,'Unrelated','Caller','calls',1,0,NULL,NULL),
        (3,'Wanted','Unrelated','calls',1,0,NULL,NULL);").unwrap();
    let mut args = arguments(&fixture, "impact", "unused");
    args.as_object_mut().unwrap().remove("query");
    args["analysisProjection"]["files"] = json!(["target.ts"]);
    args["analysisProjection"]["depth"] = json!(1);
    let before = std::fs::read(&fixture.database).unwrap();
    let status_before = std::fs::read(fixture.database.parent().unwrap().join("maintenance-status.json")).unwrap();
    let direct = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(direct["roots"], json!(["Wanted"]));
    assert_eq!(ids(&direct, "nodes"), ["Wanted", "Caller"]);
    assert_eq!(direct["edges"].as_array().unwrap().len(), 1, "outgoing dependencies are not dependents");
    assert!(direct.get("risk").is_none() && direct.get("testGaps").is_none());
    args["analysisProjection"]["depth"] = json!(2);
    let indirect = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(ids(&indirect, "nodes"), ["Wanted", "Caller", "Unrelated"]);
    assert_eq!(indirect["nodes"][2]["depth"], 2);
    assert_eq!(indirect["edges"].as_array().unwrap().len(), 3, "induced edges include the cycle without duplicate nodes");
    args["analysisProjection"]["files"] = json!(["target.ts", "caller.ts", "target.ts"]);
    let multi = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(multi["roots"], json!(["Caller", "Wanted"]));
    assert_eq!(multi["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(std::fs::read(&fixture.database).unwrap(), before);
    assert_eq!(std::fs::read(fixture.database.parent().unwrap().join("maintenance-status.json")).unwrap(), status_before);
}

#[test]
fn projection_impact_refuses_stale_deleted_excluded_and_foreign_paths_without_adoption() {
    let mut fixture = IndexedFixture::new();
    let mut args = arguments(&fixture, "impact", "unused");
    for files in [json!([]), json!(["../target.ts"]), json!(["/target.ts"]), json!(["excluded.ts"])] {
        args["analysisProjection"]["files"] = files;
        assert!(fixture.call(&args).is_err());
    }
    args["analysisProjection"]["files"] = json!(["target.ts"]);
    std::fs::write(fixture.context.root.join("target.ts"), "function Wanted() { return 8; }\n").unwrap();
    assert!(fixture.call(&args).unwrap_err().contains("changed"));
    std::fs::remove_file(fixture.context.root.join("target.ts")).unwrap();
    assert!(fixture.call(&args).is_err());
    add_current_source(&mut fixture, "new.ts", "NotIndexed", "function NotIndexed() {}\n", 1, false);
    args = arguments(&fixture, "impact", "unused");
    args["analysisProjection"]["files"] = json!(["new.ts"]);
    let unseeded = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(unseeded["status"], "incomplete");
    assert_eq!(unseeded["selection"]["unseededFiles"], json!(["new.ts"]));
    assert_eq!(unseeded["coverage"]["complete"], false);
    assert!(unseeded["nodes"].as_array().unwrap().is_empty());
}

#[test]
fn projection_callers_depth_reaches_indirect_tests_only_through_incoming_call_evidence() {
    let mut fixture = IndexedFixture::new();
    add_current_source(&mut fixture, "tests/indirect.ts", "IndirectSpec", "function IndirectSpec() { return Caller(); }\n", 1, true);
    add_current_source(&mut fixture, "tests/reference.ts", "ReferenceSpec", "function ReferenceSpec() { return Caller; }\n", 1, true);
    add_current_source(&mut fixture, "tests/unrelated.ts", "UnrelatedSpec", "function UnrelatedSpec() { return 0; }\n", 1, true);
    fixture.connection.execute_batch("INSERT INTO edges VALUES
        (2,'IndirectSpec','Caller','calls',1,0,NULL,NULL),
        (3,'ReferenceSpec','Caller','references',1,0,'{\"fnRef\":true}',NULL),
        (4,'UnrelatedSpec','Caller','contains',NULL,NULL,NULL,NULL),
        (5,'UnrelatedSpec','Wanted','imports',NULL,NULL,NULL,NULL),
        (6,'UnrelatedSpec','Caller','references',1,0,'{}',NULL),
        (7,'Wanted','UnrelatedSpec','calls',1,0,NULL,NULL);").unwrap();
    let default = data(&fixture, "callers", "Wanted");
    assert_eq!(ids(&default, "nodes"), ["Wanted", "Caller"]);
    assert_eq!(default["coverage"]["depth"], 1);
    assert_eq!(default["edges"].as_array().unwrap().len(), 1);
    let mut args = arguments(&fixture, "callers", "Wanted");
    args["analysisProjection"]["depth"] = json!(1);
    assert_eq!(fixture.call(&args).unwrap().structured["data"], default);
    args["analysisProjection"]["depth"] = json!(2);
    let indirect = fixture.call(&args).unwrap().structured["data"].clone();
    assert_eq!(ids(&indirect, "nodes"), ["Wanted", "Caller", "IndirectSpec", "ReferenceSpec"]);
    assert_eq!(indirect["coverage"]["depth"], 2);
    assert_eq!(indirect["coverage"]["complete"], true);
    for node in indirect["nodes"].as_array().unwrap().iter().skip(2) {
        assert_eq!(node["depth"], 2);
        assert_eq!(node["isTestFile"], true);
    }
    let edges = indirect["edges"].as_array().unwrap();
    assert_eq!(edges.iter().map(|edge| edge["id"].as_i64().unwrap()).collect::<Vec<_>>(), [1,2,3]);
    assert_eq!(edges[1]["source"], "IndirectSpec");
    assert_eq!(edges[1]["target"], "Caller", "retain the causal hop, not only root-incident edges");
    assert_eq!(edges[2]["functionReference"], true);
    assert_eq!(indirect["analysis"]["indexedRunId"], default["analysis"]["indexedRunId"]);
    for depth in [json!(0), json!(7), json!(1.5), json!("2")] {
        args["analysisProjection"]["depth"] = depth;
        assert!(fixture.call(&args).is_err());
    }
    args["analysisProjection"]["depth"] = json!(6);
    assert_eq!(ids(&fixture.call(&args).unwrap().structured["data"], "nodes"), ids(&indirect, "nodes"));
}
