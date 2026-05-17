use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DailyEntry {
    pub date: String, // "YYYY-MM-DD"
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Notebook {
    pub today_date: String, // "YYYY-MM-DD"; empty for a never-rolled-over notebook
    #[serde(default)]
    pub today: String,
    #[serde(default)]
    pub history: Vec<DailyEntry>,
}

impl Default for Notebook {
    fn default() -> Self {
        Self {
            today_date: String::new(),
            today: String::new(),
            history: Vec::new(),
        }
    }
}

impl Notebook {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Notebook serializes")
    }

    /// Parse a Notebook, falling back to the legacy `Note { text }` shape used
    /// before history was introduced. Old data becomes the new `today` with
    /// an empty date (rollover on the next launch will pick the right day).
    pub fn from_bytes(bytes: &[u8]) -> serde_json::Result<Self> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Compat {
            Notebook(Notebook),
            Legacy { text: String },
        }
        match serde_json::from_slice::<Compat>(bytes)? {
            Compat::Notebook(nb) => Ok(nb),
            Compat::Legacy { text } => Ok(Notebook {
                today_date: String::new(),
                today: text,
                history: Vec::new(),
            }),
        }
    }
}

/// True if a line is an unfinished todo (`[]` or `[ ]`, ignoring leading whitespace).
fn is_unfinished_todo(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("[]") || trimmed.starts_with("[ ]")
}

/// True if a line is an H1 ATX heading (`# `, no leading whitespace).
fn is_h1(line: &str) -> bool {
    line.starts_with("# ")
}

/// Extract unfinished todo lines from `text`, preserving each line's original
/// indentation. Returns one cloned line per match.
pub fn unfinished_todos(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| is_unfinished_todo(l))
        .map(|l| l.to_string())
        .collect()
}

/// Walk `line` finding inline-code tag segments. For each one, calls `f` with
/// the byte range of the **content** (between backticks), the tag name, and
/// the value substring (everything after the first `:`, or empty if no colon).
/// Both name and value are trimmed. Returns when `f` returns Some(R).
fn scan_tags<R>(
    line: &str,
    mut f: impl FnMut(usize, usize, &str, &str) -> Option<R>,
) -> Option<R> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end] != b'`' {
            end += 1;
        }
        if end >= bytes.len() {
            break; // unclosed
        }
        let content = &line[start..end];
        let (name, value) = match content.find(':') {
            Some(idx) => (content[..idx].trim(), content[idx + 1..].trim()),
            None => (content.trim(), ""),
        };
        if let Some(r) = f(start, end, name, value) {
            return Some(r);
        }
        i = end + 1;
    }
    None
}

/// True if `line` contains an inline-code tag whose name is `tag_name`.
fn line_has_tag(line: &str, tag_name: &str) -> bool {
    scan_tags(line, |_, _, name, _| {
        if name == tag_name { Some(()) } else { None }
    })
    .is_some()
}

/// Extract the numeric value of the first tag named `tag_name` on the line,
/// e.g. `parse_tag_count(line, "expiry") == Some(3)` for `` `expiry:3` ``.
fn parse_tag_count(line: &str, tag_name: &str) -> Option<u32> {
    scan_tags(line, |_, _, name, value| {
        if name == tag_name { value.parse::<u32>().ok() } else { None }
    })
}

/// Substitute the value of the first tag named `tag_name` on the line, leaving
/// surrounding text and backticks intact. Returns the line unchanged if not found.
fn replace_tag_value(line: &str, tag_name: &str, new_value: &str) -> String {
    if let Some((start, end)) = scan_tags(line, |s, e, name, _| {
        if name == tag_name { Some((s, e)) } else { None }
    }) {
        format!("{}{}:{}{}", &line[..start], tag_name, new_value, &line[end..])
    } else {
        line.to_string()
    }
}

fn has_persist_tag(lines: &[String]) -> bool {
    lines.iter().any(|l| line_has_tag(l, "persist"))
}

fn is_checked_todo(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("[x]") || trimmed.starts_with("[X]")
}

/// Extract `(n, r)` from `` `repeat:n,r` ``. Both numbers must be present and
/// parse as `u32`; otherwise returns None.
fn parse_repeat(line: &str) -> Option<(u32, u32)> {
    scan_tags(line, |_, _, name, value| {
        if name != "repeat" {
            return None;
        }
        let mut parts = value.split(',');
        let n = parts.next()?.trim().parse::<u32>().ok()?;
        let r = parts.next()?.trim().parse::<u32>().ok()?;
        Some((n, r))
    })
}

/// Replace leading `[x]`/`[X]` with `[ ]`, preserving indentation.
fn uncheck_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let indent_len = line.len() - trimmed.len();
    let indent = &line[..indent_len];
    if let Some(rest) = trimmed
        .strip_prefix("[x]")
        .or_else(|| trimmed.strip_prefix("[X]"))
    {
        format!("{}[ ]{}", indent, rest)
    } else {
        line.to_string()
    }
}

/// Remove every inline-code tag named `tag_name`, plus one preceding space if
/// present (so `"foo `tag`"` becomes `"foo"`, not `"foo "`).
fn strip_tag(line: &str, tag_name: &str) -> String {
    let mut result = line.to_string();
    loop {
        let Some((start, end)) = scan_tags(&result, |s, e, name, _| {
            if name == tag_name { Some((s, e)) } else { None }
        }) else {
            break;
        };
        let mut from = start - 1; // include opening backtick
        let to = end + 1; // include closing backtick
        if from > 0 && result.as_bytes()[from - 1] == b' ' {
            from -= 1;
        }
        result = format!("{}{}", &result[..from], &result[to..]);
    }
    result
}

/// Roll one line through the expiry + repeat pipeline.
///
/// Order: repeat is processed first because a repeat that fires (r→0)
/// unchecks the box and strips any `expires:` tag — semantically the task is
/// renewing, so the expiry stamp from its prior check no longer applies.
///
/// Then expires:
/// - `expires:k` decrements to `k-1`; line dropped at 0.
/// - Untagged `[x]` in an expiry group gets stamped `expires:N`.
///
/// Anything else passes through unchanged.
fn process_line(line: &str, group_expiry: Option<u32>) -> Option<String> {
    // `newtab` is a structural marker — always survives unchanged so the
    // tab skeleton persists across days, independent of other tag logic.
    if line_has_tag(line, "newtab") {
        return Some(line.to_string());
    }

    let mut line = line.to_string();

    if is_checked_todo(&line) {
        if let Some((n, r)) = parse_repeat(&line) {
            let new_r = r.saturating_sub(1);
            if new_r == 0 {
                line = uncheck_line(&line);
                line = strip_tag(&line, "expires");
                line = replace_tag_value(&line, "repeat", &format!("{},0", n));
                return Some(line);
            }
            line = replace_tag_value(&line, "repeat", &format!("{},{}", n, new_r));
        }
    }

    if let Some(k) = parse_tag_count(&line, "expires") {
        let new_k = k.saturating_sub(1);
        if new_k == 0 {
            return None;
        }
        return Some(replace_tag_value(&line, "expires", &new_k.to_string()));
    }
    if let Some(n) = group_expiry {
        if is_checked_todo(&line) {
            return Some(format!("{} `expires:{}`", line.trim_end(), n));
        }
    }

    Some(line)
}

/// Compute the carry-forward text for the next day.
///
/// Groups are partitioned by `# Header` lines.
///
/// - `` `persist` `` group: entire group is carried verbatim (subject to
///   per-line expiry decrement; expired `expires:0` lines still drop).
/// - `` `expiry:N` `` group: structure preserved; checked todos without an
///   `expires:` tag are stamped with `expires:N`; existing `expires:k` are
///   decremented (dropped at 0).
/// - Regular group: only unfinished todos carry. `[x]` lines bearing an
///   `expires:k` tag also carry, decremented (and dropped at 0) — this lets
///   a previously-stamped item finish counting down even after the user
///   removes the group's `expiry` tag.
pub fn carry_forward(text: &str) -> String {
    let mut sections: Vec<Section> = Vec::new();
    sections.push(Section { header: None, content: Vec::new() });

    for line in text.lines() {
        if is_h1(line) {
            sections.push(Section {
                header: Some(line.to_string()),
                content: Vec::new(),
            });
        } else {
            sections.last_mut().unwrap().content.push(line.to_string());
        }
    }

    let mut out: Vec<String> = Vec::new();
    for s in sections {
        let header_persists = s
            .header
            .as_ref()
            .map(|h| line_has_tag(h, "persist"))
            .unwrap_or(false);
        let persist = header_persists || has_persist_tag(&s.content);

        let group_expiry = s
            .header
            .as_ref()
            .and_then(|h| parse_tag_count(h, "expiry"))
            .or_else(|| s.content.iter().find_map(|l| parse_tag_count(l, "expiry")));

        if persist || group_expiry.is_some() {
            if let Some(h) = s.header {
                out.push(h);
            }
            for l in s.content {
                if let Some(p) = process_line(&l, group_expiry) {
                    out.push(p);
                }
            }
        } else {
            // Keep the header if it bears `newtab` (structural marker) or if
            // any line in the section is an unfinished todo (preserves the
            // grouping context for the surviving todos).
            let has_unfinished = s.content.iter().any(|l| is_unfinished_todo(l));
            let header_has_newtab = s
                .header
                .as_ref()
                .map(|h| line_has_tag(h, "newtab"))
                .unwrap_or(false);
            if has_unfinished || header_has_newtab {
                if let Some(h) = s.header { out.push(h); }
            }
            for l in s.content {
                if line_has_tag(&l, "newtab") {
                    out.push(l);
                } else if is_unfinished_todo(&l) {
                    out.push(l);
                } else if line_has_tag(&l, "expires") || line_has_tag(&l, "repeat") {
                    if let Some(p) = process_line(&l, None) {
                        out.push(p);
                    }
                }
            }
        }
    }

    out.join("\n")
}

struct Section {
    header: Option<String>,
    content: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_note_parses() {
        let bytes = br#"{"text":"hello world"}"#;
        let nb = Notebook::from_bytes(bytes).unwrap();
        assert_eq!(nb.today, "hello world");
        assert_eq!(nb.today_date, "");
        assert!(nb.history.is_empty());
    }

    #[test]
    fn notebook_parses() {
        let bytes = br#"{"today_date":"2026-05-15","today":"x","history":[]}"#;
        let nb = Notebook::from_bytes(bytes).unwrap();
        assert_eq!(nb.today_date, "2026-05-15");
        assert_eq!(nb.today, "x");
    }

    #[test]
    fn extracts_unfinished_todos() {
        let text = "[] one\n  [ ] two\n[x] three\n[X] four\n[] five\nplain\n";
        let v = unfinished_todos(text);
        assert_eq!(v, vec!["[] one", "  [ ] two", "[] five"]);
    }

    #[test]
    fn carry_no_headers_is_per_line() {
        let txt = "[] one\n[x] two\n[] three\n";
        assert_eq!(carry_forward(txt), "[] one\n[] three");
    }

    #[test]
    fn carry_group_keeps_header_and_unfinished_drops_prose() {
        let txt = "# Errands\n[] buy milk\n[x] done thing\nnotes\n# Done\n[x] finished\n";
        // # Errands has [] → header kept, unfinished kept. # Done has no
        // unfinished → header and content dropped.
        assert_eq!(carry_forward(txt), "# Errands\n[] buy milk");
    }

    #[test]
    fn carry_drops_group_with_no_unfinished() {
        let txt = "# All done\n[x] done\nbla\n";
        assert_eq!(carry_forward(txt), "");
    }

    #[test]
    fn carry_mixes_pre_header_and_grouped() {
        let txt = "[] loose\n[x] done loose\n# Group\n[] g1\n# Empty\n";
        assert_eq!(carry_forward(txt), "[] loose\n# Group\n[] g1");
    }

    #[test]
    fn carry_persist_keeps_whole_group() {
        let txt = "# Recipes `persist`\n[x] pasta\nshopping list\n# Errands\n[] buy milk\n";
        // # Recipes kept by persist. # Errands kept because it has an unfinished todo.
        assert_eq!(
            carry_forward(txt),
            "# Recipes `persist`\n[x] pasta\nshopping list\n# Errands\n[] buy milk"
        );
    }

    #[test]
    fn carry_persist_tag_in_content_works() {
        let txt = "# Recipes\n`persist`\n[x] pasta\n";
        assert_eq!(carry_forward(txt), "# Recipes\n`persist`\n[x] pasta");
    }

    #[test]
    fn carry_persist_with_value_works() {
        let txt = "# Notes `persist:always`\nsome prose\n";
        assert_eq!(carry_forward(txt), "# Notes `persist:always`\nsome prose");
    }

    #[test]
    fn carry_persist_in_default_group_keeps_default() {
        let txt = "`persist`\nstanding notes\n[x] done\n# Group\n[x] also done\n";
        assert_eq!(carry_forward(txt), "`persist`\nstanding notes\n[x] done");
    }

    #[test]
    fn carry_h2_is_not_a_boundary() {
        let txt = "# H1\n## sub\n[x] done\n";
        // ## stays inside H1 group; no unfinished → whole group drops.
        assert_eq!(carry_forward(txt), "");
    }

    #[test]
    fn carry_h2_inside_group_keeps_header_and_unfinished_todos() {
        let txt = "# H1\n## sub\n[] todo\nfoo\n";
        // H1 has [] → header kept. ## sub and `foo` are not todos, dropped.
        assert_eq!(carry_forward(txt), "# H1\n[] todo");
    }

    #[test]
    fn line_has_tag_ignores_unrelated_backticks() {
        assert!(!line_has_tag("`code` is not a tag", "persist"));
        assert!(line_has_tag("intro `persist` outro", "persist"));
        assert!(line_has_tag("`persist:7`", "persist"));
        assert!(!line_has_tag("`persistent`", "persist"));
        assert!(!line_has_tag("`persist", "persist")); // unclosed
    }

    #[test]
    fn parse_tag_count_extracts_number() {
        assert_eq!(parse_tag_count("# H `expiry:5`", "expiry"), Some(5));
        assert_eq!(parse_tag_count("[x] foo `expires:1`", "expires"), Some(1));
        assert_eq!(parse_tag_count("nope", "expiry"), None);
        assert_eq!(parse_tag_count("`expiry:abc`", "expiry"), None);
    }

    #[test]
    fn replace_tag_value_substitutes_in_place() {
        assert_eq!(
            replace_tag_value("[x] foo `expires:3` bar", "expires", "2"),
            "[x] foo `expires:2` bar"
        );
        assert_eq!(
            replace_tag_value("prefix `expires:10`", "expires", "9"),
            "prefix `expires:9`"
        );
        // No-op when tag absent.
        assert_eq!(replace_tag_value("no tag here", "expires", "1"), "no tag here");
    }

    #[test]
    fn carry_expiry_stamps_checked_boxes() {
        let txt = "# Recipes `expiry:3`\n[x] pasta\n[] cook\n";
        assert_eq!(
            carry_forward(txt),
            "# Recipes `expiry:3`\n[x] pasta `expires:3`\n[] cook"
        );
    }

    #[test]
    fn carry_expiry_decrements_existing_expires() {
        let txt = "# Recipes `expiry:3`\n[x] pasta `expires:2`\n";
        assert_eq!(
            carry_forward(txt),
            "# Recipes `expiry:3`\n[x] pasta `expires:1`"
        );
    }

    #[test]
    fn carry_expiry_drops_zero_expires() {
        let txt = "# Recipes `expiry:3`\n[x] pasta `expires:1`\n[] cook\n";
        assert_eq!(carry_forward(txt), "# Recipes `expiry:3`\n[] cook");
    }

    #[test]
    fn carry_regular_group_keeps_expires_lines_for_decrement() {
        // User removed `expiry:3` from header but boxes already stamped should
        // keep counting down rather than vanishing instantly. Header survives
        // because the section still has an unfinished todo.
        let txt = "# Recipes\n[x] pasta `expires:2`\n[x] no-tag\n[] cook\n";
        assert_eq!(
            carry_forward(txt),
            "# Recipes\n[x] pasta `expires:1`\n[] cook"
        );
    }

    #[test]
    fn carry_persist_with_expiry_combines() {
        // Persist preserves prose; expiry still decrements/stamps boxes.
        let txt = "# Notes `persist` `expiry:2`\nprose\n[x] checked\n[x] old `expires:1`\n";
        assert_eq!(
            carry_forward(txt),
            "# Notes `persist` `expiry:2`\nprose\n[x] checked `expires:2`"
        );
    }

    #[test]
    fn carry_expiry_in_default_group_works() {
        let txt = "`expiry:2`\n[x] foo\n[] bar\n";
        assert_eq!(
            carry_forward(txt),
            "`expiry:2`\n[x] foo `expires:2`\n[] bar"
        );
    }

    #[test]
    fn parse_repeat_extracts_pair() {
        assert_eq!(parse_repeat("[x] water `repeat:3,3`"), Some((3, 3)));
        assert_eq!(parse_repeat("`repeat:7,2` prefix"), Some((7, 2)));
        assert_eq!(parse_repeat("`repeat:3`"), None); // missing r
        assert_eq!(parse_repeat("`repeat:a,b`"), None);
        assert_eq!(parse_repeat("nope"), None);
    }

    #[test]
    fn strip_tag_removes_leading_space() {
        assert_eq!(
            strip_tag("[x] task `expires:2` keep", "expires"),
            "[x] task keep"
        );
        assert_eq!(
            strip_tag("[x] task `expires:2`", "expires"),
            "[x] task"
        );
    }

    #[test]
    fn carry_repeat_decrements_r() {
        let txt = "[x] water plants `repeat:3,3`\n";
        assert_eq!(
            carry_forward(txt),
            "[x] water plants `repeat:3,2`"
        );
    }

    #[test]
    fn carry_repeat_unchecks_at_zero() {
        let txt = "[x] water plants `repeat:3,1`\n";
        assert_eq!(
            carry_forward(txt),
            "[ ] water plants `repeat:3,0`"
        );
    }

    #[test]
    fn carry_repeat_unchecked_is_pass_through() {
        // [ ] is an unfinished todo: caught by the unfinished branch, untouched.
        let txt = "[ ] water plants `repeat:3,0`\n";
        assert_eq!(
            carry_forward(txt),
            "[ ] water plants `repeat:3,0`"
        );
    }

    #[test]
    fn carry_regular_group_keeps_repeat_lines() {
        let txt = "# Habits\n[x] yoga `repeat:2,2`\n[x] no-tag\n[] dishes\n";
        // Header survives because the section has an unfinished todo.
        assert_eq!(
            carry_forward(txt),
            "# Habits\n[x] yoga `repeat:2,1`\n[] dishes"
        );
    }

    #[test]
    fn carry_repeat_fire_strips_expires() {
        // expires was stamped when checked; firing repeat (uncheck) wipes it
        // so the task isn't deleted while now-unchecked.
        let txt = "[x] task `expires:5` `repeat:2,1`\n";
        assert_eq!(
            carry_forward(txt),
            "[ ] task `repeat:2,0`"
        );
    }

    #[test]
    fn carry_header_drops_when_all_done() {
        let txt = "# Cleared\n[x] done\nfoo\n";
        assert_eq!(carry_forward(txt), "");
    }

    #[test]
    fn carry_newtab_survives_regular_section() {
        let txt = "[x] done\n`newtab`\n[] todo\n";
        assert_eq!(carry_forward(txt), "`newtab`\n[] todo");
    }

    #[test]
    fn carry_newtab_survives_inside_expiry_group_unchanged() {
        let txt = "# Group `expiry:3`\n[x] foo\n`newtab`\n";
        assert_eq!(
            carry_forward(txt),
            "# Group `expiry:3`\n[x] foo `expires:3`\n`newtab`"
        );
    }

    #[test]
    fn carry_newtab_in_header_keeps_header() {
        let txt = "# Section `newtab`\nbody\n[] keep me\n";
        assert_eq!(carry_forward(txt), "# Section `newtab`\n[] keep me");
    }

    #[test]
    fn carry_repeat_and_expires_decrement_in_parallel() {
        let txt = "[x] task `expires:3` `repeat:5,3`\n";
        assert_eq!(
            carry_forward(txt),
            "[x] task `expires:2` `repeat:5,2`"
        );
    }
}
