function auditCommandDocs() {
  return [
    {
      id: "overview",
      title: "Overview",
      eyebrow: "Getting Started",
      summary: "The default model is one managed WOS project per working directory under ./.iiaide-wos-cli/.",
      sections: [
        {
          title: "Core workspace",
          commands: [
            "iiaide-wos init",
            "iiaide-wos workspace",
            "iiaide-wos show",
            "iiaide-wos path",
          ],
          notes: [
            "Default mode does not need --task.",
            "The current directory name becomes the managed project id.",
          ],
        },
        {
          title: "Common options",
          commands: [
            "--sid <SID>",
            "--from-browser",
            "--json",
            "--jsonl",
            "--debug",
            "--quiet",
            "--force",
          ],
          notes: [
            "--json is the preferred machine-readable interface.",
            "--debug writes browser and session progress to stderr.",
          ],
        },
      ],
    },
    {
      id: "recipes",
      title: "Recipes",
      eyebrow: "Use Cases",
      summary: "Scenario-based command sequences for common literature search, ingest, export, and audit workflows.",
      sections: [
        {
          title: "Start a new literature project",
          commands: [
            "mkdir ./my-wos-project && cd ./my-wos-project",
            "iiw init",
            "iiw settings sid add \"<SID>\"",
            "iiw check sid",
            "iiw db audit-html",
          ],
          notes: [
            "Default mode stores project state under ./.iiaide-wos-cli/.",
            "Use db audit-html any time you want a local timeline view of what has happened in this project.",
          ],
        },
        {
          title: "Search, ingest, and review a normal query",
          commands: [
            "iiw query build --expr 'TS=(\"two-dimensional materials\") AND PY=(2026)'",
            "iiw query ingest --expr 'TS=(\"two-dimensional materials\") AND PY=(2026)' --description \"2D materials 2026\"",
            "iiw db searches --limit 20",
            "iiw db context --wosid \"WOS:000000000000001\" --type self --json",
          ],
          notes: [
            "query build discovers a UUID; query ingest parses and stores records in wosData.sqlite.",
            "Normal query ingest uses relevance order and isRefQuery=false.",
          ],
        },
        {
          title: "Collect citations, references, or related records",
          commands: [
            "iiw record collect --wosid \"WOS:000000000000001\" --json",
            "iiw record ingest --wosid \"WOS:000000000000001\" --type citations",
            "iiw record ingest --wosid \"WOS:000000000000001\" --type references",
            "iiw record ingest --wosid \"WOS:000000000000001\" --type related",
            "iiw db list --wosid \"WOS:000000000000001\" --type references --json",
            "iiw db list --wosid \"WOS:000000000000001\" --type references --context --json",
            "iiw db context --wosid \"WOS:000000000000001\" --type references --limit 100 --json",
          ],
          notes: [
            "record collect discovers relation UUIDs and WOSID CSV artifacts.",
            "record ingest collects WOSIDs from at most the first 6 relevance pages, queries those WOSIDs, and stores records under the relation UUID.",
            "db list returns the ordered stored WOSID list from SQLite; --context adds title, abstract, keywords, and authors.",
            "Confirmed zero-count relation results are stored and reused; db list returns ok=true with an empty wosids array.",
            "Relation ingest resultsets are marked exportMode=front-scroll-wosid and uuidDirectExport=false.",
            "record ingest is idempotent for the same source WOSID and relation type unless --force is passed.",
          ],
        },
        {
          title: "Review a confirmed empty relation",
          commands: [
            "iiw record ingest --wosid \"WOS:000000000000001\" --type citations --json",
            "iiw db list --wosid \"WOS:000000000000001\" --type citations --json",
            "iiw db wosid --wosid \"WOS:000000000000001\" --json",
            "iiw record ingest --wosid \"WOS:000000000000001\" --type citations --force --json",
          ],
          notes: [
            "If WOS confirms zero citations/references/related records, record ingest stores the relation UUID with emptyResult=true.",
            "db list then returns ok=true, count=0, and wosids=[] from SQLite without opening WOS.",
            "Run the same record ingest command again to reuse the stored empty result; add --force only when you want to re-check WOS.",
          ],
        },
        {
          title: "Download files without SQLite ingest",
          commands: [
            "iiw run --uuid \"<uuid>\"",
            "iiw run --uuid \"<relation-uuid>\" --ref-query",
            "iiw bib --uuid \"<uuid>\"",
            "iiw batch-run --search-root \".\"",
          ],
          notes: [
            "run downloads raw TXT only and bib downloads BibTeX only.",
            "Use query ingest or record ingest when you want parsed records in SQLite.",
          ],
        },
        {
          title: "Audit and export a project report",
          commands: [
            "iiw db timeline --limit 100",
            "iiw db runs --limit 50",
            "iiw db searches --limit 50",
            "iiw db artifacts --limit 50",
            "iiw db audit-html",
            "iiw db audit-export --format both",
          ],
          notes: [
            "Audit lookup commands are read-only and do not open WOS.",
            "db audit-export writes an archiveable HTML and JSON snapshot.",
          ],
        },
      ],
    },
    {
      id: "query",
      title: "Query",
      eyebrow: "UUID Discovery",
      summary: "Discover WOS result-set UUIDs from expressions, parsed text, ids, or direct SQLite ingest.",
      sections: [
        {
          title: "Build and parse",
          commands: [
            "iiaide-wos query build --expr 'PY=(2026)'",
            "iiaide-wos query batch --expr 'PY=(2025)' --expr 'PY=(2026)'",
            "cat > queries.txt <<'EOF'\n# Two-dimensional materials project: compare recent yearly result sets\nTS=(\"two-dimensional materials\") AND PY=(2025)\nTS=(\"two-dimensional materials\") AND PY=(2026)\n\n# Atomic thickness theory slice\nTS=((\"two-dimensional materials\" OR graphene OR \"transition metal dichalcogenide*\") AND (\"atomic thickness\" OR monolayer) AND (theor* OR model* OR simulation*))\nEOF\niiaide-wos query batch --expr-file ./queries.txt",
            "iiaide-wos query parse --text \"2026 AI safety papers\"",
            "iiaide-wos query batch --expr-file \"./queries.txt\" --jsonl",
          ],
          notes: [
            "query build prints compact single-line JSON by default with uuid, url, count, queryText, and cached.",
            "query build reuses the same successful task/query text from SQLite by default; add --force to query WOS again.",
            "query parse and query ids print UUID by default.",
            "query build uses Add to history and the Search split-button arrow menu instead of clicking the main Search/run button.",
            "query batch accepts repeated --expr and/or --expr-file, emits one LLM-readable JSON object per line by default, and uses one WOS browser session for uncached expressions.",
            "A query batch file is plain UTF-8 text: one WOS advanced-search expression per line; blank lines and lines starting with # are ignored.",
          ],
        },
        {
          title: "IDs and ingest",
          commands: [
            "iiaide-wos query ids --wosid \"WOS:000000000000001\"",
            "iiaide-wos query ids --csv \"./input/ids.csv\"",
            "iiaide-wos query ingest --expr 'PY=(2026)' --description \"2026 search\"",
          ],
          notes: [
            "query ingest writes structured records into wosData.sqlite.",
            "Normal query ingest uses isRefQuery=false and relevance order.",
          ],
        },
      ],
    },
    {
      id: "record",
      title: "Record",
      eyebrow: "Relations",
      summary: "Resolve citations, references, related records, shared references, and SQLite relation ingest.",
      sections: [
        {
          title: "Relation discovery",
          commands: [
            "iiaide-wos record relations --wosid \"WOS:000000000000001\" --type citations",
            "iiaide-wos record collect --wosid \"WOS:000000000000001\" --json",
            "iiaide-wos record shared --wosid \"WOS:000000000000001\" --with \"WOS:000000000000002\"",
          ],
          notes: [
            "record collect writes relation JSON and per-relation WOSID CSV files.",
            "Supported relation types are citations, references, and related.",
          ],
        },
        {
          title: "Relation ingest",
          commands: [
            "iiaide-wos record ingest --wosid \"WOS:000000000000001\" --type references",
            "iiaide-wos db list --wosid \"WOS:000000000000001\" --type references --json",
            "iiaide-wos db list --wosid \"WOS:000000000000001\" --type references --context --json",
            "iiaide-wos db context --wosid \"WOS:000000000000001\" --type references --json",
          ],
          notes: [
            "record ingest uses isRefQuery=true for relation metadata, but it does not directly export the relation UUID.",
            "It collects WOSIDs from at most the first 6 relevance pages, queries those WOSIDs, and stores full records under the relation UUID.",
            "Confirmed zero-count relation results are stored with emptyResult=true and reused unless --force is passed.",
            "If the same source WOSID and relation type already exists in SQLite, record ingest reuses it unless --force is passed.",
          ],
        },
      ],
    },
    {
      id: "export",
      title: "Export",
      eyebrow: "Files",
      summary: "Download raw TXT and BibTeX exports without parsing them into structured records.",
      sections: [
        {
          title: "TXT and BibTeX",
          commands: [
            "iiaide-wos run --uuid \"<uuid>\"",
            "iiaide-wos run --uuid \"<relation-uuid>\" --ref-query",
            "iiaide-wos bib --uuid \"<uuid>\"",
            "iiaide-wos batch-run --search-root \".\"",
          ],
          notes: [
            "run downloads raw field-tagged TXT only.",
            "bib downloads raw BibTeX only.",
            "Both write audit metadata but do not write parsed records into SQLite.",
          ],
        },
        {
          title: "Range and reuse",
          commands: [
            "--from-index <n>",
            "--limit <n>",
            "--batch-size <n>",
            "--reuse-raw",
            "--allow-large-export",
          ],
          notes: [
            "Large TXT exports can use author sort windows when allowed.",
            "reuse-raw repairs or resumes from existing resultset files when possible.",
          ],
        },
      ],
    },
    {
      id: "db",
      title: "Database",
      eyebrow: "Read-Only Review",
      summary: "Review task SQLite content, audit history, and exported timeline views without opening WOS.",
      sections: [
        {
          title: "Metadata lookups",
          commands: [
            "iiaide-wos db uuid --uuid \"<uuid>\" --json",
            "iiaide-wos db wosid --wosid \"WOS:000000000000001\" --json",
            "iiaide-wos db list --uuid \"<uuid>\" --json",
            "iiaide-wos db list --uuid \"<uuid>\" --context --json",
            "iiaide-wos db list --wosid \"WOS:000000000000001\" --type citations --json",
            "iiaide-wos db list --wosid \"WOS:000000000000001\" --type references --context --json",
            "iiaide-wos db context --wosid \"WOS:000000000000001\" --type self --json",
            "iiaide-wos db context --wosid \"WOS:000000000000001\" --type references --limit 100 --json",
          ],
          notes: [
            "db uuid, db wosid, db list, and db context are read-only.",
            "db list returns ordered WOSIDs from SQLite. Use --context for title, abstract, keywords, and authors.",
            "Confirmed empty relation resultsets return ok=true, count=0, and wosids=[].",
            "db context supports self, citations, references, and related.",
          ],
        },
        {
          title: "Audit review",
          commands: [
            "iiaide-wos db searches --limit 50 --json",
            "iiaide-wos db artifacts --limit 50 --json",
            "iiaide-wos db runs --limit 50 --json",
            "iiaide-wos db timeline --limit 100 --json",
            "iiaide-wos db audit-html",
            "iiaide-wos db audit-export",
          ],
          notes: [
            "db audit-html starts the local AJAX audit workspace.",
            "db audit-export writes a static HTML/JSON report snapshot.",
          ],
        },
      ],
    },
    {
      id: "auth",
      title: "Auth",
      eyebrow: "SID And Browser",
      summary: "Validate saved SID state, trigger browser repair, or keep a background SID pool refreshed.",
      sections: [
        {
          title: "Validation and pool",
          commands: [
            "iiaide-wos check",
            "iiaide-wos sid --from-browser --debug",
            "iiaide-wos sid-pool",
            "iiaide-wos settings --add-sid \"<SID>\"",
          ],
          notes: [
            "If a saved SID is invalid, the browser repair flow reopens WOS and updates the shared pool.",
            "SIDs are shared across projects through global config.",
          ],
        },
        {
          title: "Auth producer",
          commands: [
            "iiaide-wos auth login --provider must",
            "iiaide-wos auth monitor --provider must",
          ],
          notes: [
            "auth monitor keeps the saved SID pool above the configured threshold.",
            "Do not print or log full SID values.",
          ],
        },
      ],
    },
    {
      id: "project",
      title: "Project",
      eyebrow: "Lifecycle",
      summary: "Inspect current project state, list known projects, or clear managed data when needed.",
      sections: [
        {
          title: "Inspection",
          commands: [
            "iiaide-wos list",
            "iiaide-wos tasks",
            "iiaide-wos latest",
            "iiaide-wos validate",
          ],
          notes: [
            "tasks and list are read-only views.",
            "validate checks the managed project store and expected artifacts.",
          ],
        },
        {
          title: "Import and cleanup",
          commands: [
            "iiaide-wos import --csv \"./input/wosids.csv\"",
            "iiaide-wos clear",
          ],
          notes: [
            "import records artifact audit metadata in SQLite.",
            "clear removes the managed project store after confirmation.",
          ],
        },
      ],
    },
  ];
}

module.exports = {
  auditCommandDocs,
};
