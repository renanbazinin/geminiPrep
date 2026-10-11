// Live, read-only check of the Special Group Jira connection.
//
//   npm run check:special-group -- [PROJECT_KEY] [person name]
//
// Uses the token saved by the page's Connect form (.env.special-group.local) or SPECIAL_GROUP_JIRA_* in .env.
// Every call goes through ReadOnlyJiraClient, so nothing in Jira can change. The token is never printed.

import { buildCreateLink } from "../shared/special-group/create-link.js";
import type { ProjectOptions, TicketDraft } from "../shared/special-group/types.js";
import { specialGroupConfig } from "../server/special-group/config.js";
import { findPeople, getCreateScreenFields, getProjectOptions, listProjects, screenFieldIds } from "../server/special-group/jira-lookups.js";
import { ReadOnlyJiraClient } from "../server/special-group/read-only-client.js";

let failures = 0;
const ok = (message: string) => console.log(`  ✓ ${message}`);
const warn = (message: string) => console.log(`  ! ${message}`);
const fail = (message: string) => { failures++; console.log(`  ✗ ${message}`); };
const section = (title: string) => console.log(`\n${title}`);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The draft fields the create link can fill, and the create-screen field each one needs. */
function linkFields(options: ProjectOptions): Array<[label: string, fieldId: string]> {
  return [
    ["summary", "summary"], ["description", "description"], ["priority", "priority"],
    ["reporter", "reporter"], ["assignee", "assignee"], ["labels", "labels"],
    ["components", "components"], ["fixVersions", "fixVersions"],
    ...(options.parentParam ? [[`epic/parent (${options.parentParam.name})`, options.parentParam.name] as [string, string]] : []),
  ];
}

async function main() {
  const [projectArg, personArg] = process.argv.slice(2);

  section("1. Connection");
  const config = specialGroupConfig();
  if (!config.token) { fail("No token configured. Connect on /special-group first."); return; }
  ok(`Site ${config.siteUrl}`);
  if (config.baseUrl.startsWith("https://api.atlassian.com/")) ok("Scoped token through the Atlassian gateway");
  else warn("Classic token on the site URL: it can write if the account can. A scoped read-only token is safer.");
  const client = new ReadOnlyJiraClient(config);
  try { client.get("/rest/api/3/issue"); fail("Write endpoint was not blocked"); }
  catch { ok("Write endpoints are blocked in code (no request sent)"); }
  let me: { accountId: string; displayName: string };
  try { me = await client.get("/rest/api/3/myself"); ok(`Authenticated as ${me.displayName}`); }
  catch (error) { fail(`Authentication: ${errorText(error)}`); return; }

  section("2. Projects");
  const projects = await listProjects(client).catch(error => { fail(errorText(error)); return []; });
  if (projects.length) ok(`${projects.length} visible: ${projects.map(p => p.key).join(", ")}`);
  const key = (projectArg ?? config.defaultProjectKey ?? projects[0]?.key ?? "").toUpperCase();
  if (!key) { fail("No project to check. Pass a project key."); return; }

  section(`3. Project ${key}`);
  let options: ProjectOptions;
  try { options = await getProjectOptions(client, key, { fresh: true }); }
  catch (error) { fail(errorText(error)); return; }
  const style = options.project.style === "next-gen" ? "team-managed" : "company-managed";
  ok(`${options.project.name} (id ${options.project.id}), ${style}`);
  const types = options.issueTypes.filter(t => !t.subtask);
  (types.length ? ok : fail)(`Work types you can create: ${types.map(t => t.name).join(", ") || "none"}`);
  (options.priorities.length ? ok : warn)(`Priorities: ${options.priorities.map(p => p.name).join(", ") || "none visible"}`);
  ok(`Components: ${options.components.map(c => c.name).join(", ") || "none"}`);
  ok(`Unreleased versions: ${options.versions.map(v => v.name).join(", ") || "none"}`);
  ok(`Open epics: ${options.epics.map(e => `${e.key} ${e.summary}`).join(" · ") || "none"}`);
  (options.parentParam ? ok : warn)(options.parentParam ? `Epic is prefilled through "${options.parentParam.name}"` : "No way to prefill an epic here; set it on the create screen");

  section("4. What the create link can prefill, per work type");
  const columns = linkFields(options);
  console.log(`  ${"".padEnd(14)}${columns.map(([label]) => label.split(" ")[0]!.padEnd(13)).join("")}`);
  for (const type of types) {
    try {
      const fields = await getCreateScreenFields(client, key, type.id);
      const ids = new Set(fields.map(f => f.fieldId));
      console.log(`  ${type.name.slice(0, 13).padEnd(14)}${columns.map(([, id]) => (ids.has(id) ? "✓" : "✗").padEnd(13)).join("")}`);
      const covered = new Set(["project", "issuetype", ...columns.map(([, id]) => id)]);
      const uncovered = fields.filter(f => f.required && !covered.has(f.fieldId) && !f.fieldId.startsWith("attachment"));
      if (uncovered.length) warn(`${type.name}: required but not prefilled: ${uncovered.map(f => f.name).join(", ")}`);
    } catch (error) { fail(`${type.name}: ${errorText(error)}`); }
  }
  console.log("  ✗ = not on that create screen, so Jira ignores the parameter.");

  section("5. People search");
  const query = personArg ?? me.displayName.split(" ")[0] ?? "";
  const people = await findPeople(client, query).catch(error => { fail(errorText(error)); return []; });
  (people.length ? ok : warn)(`"${query}": ${people.map(p => p.displayName).join(", ") || "no matches"}`);

  section("6. A sample link with real IDs");
  const type = types.find(t => /^(task|story)$/i.test(t.name)) ?? types.find(t => !/epic/i.test(t.name)) ?? types[0];
  const priority = options.priorities.find(p => /medium/i.test(p.name)) ?? options.priorities[0];
  const draft: TicketDraft = {
    project: { id: options.project.id, key: options.project.key, name: options.project.name },
    ...(type ? { issueType: { id: type.id, name: type.name } } : {}),
    summary: "Live check: prefilled create link (do not create)",
    description: "Context:\nGenerated by npm run check:special-group.\n\nAcceptance criteria:\n- [ ] Every field below matches the draft",
    ...(priority ? { priority } : {}),
    reporter: { accountId: me.accountId, displayName: me.displayName },
    labels: ["live-check"],
    ...(options.components[0] ? { components: [options.components[0]] } : {}),
    ...(options.versions[0] ? { fixVersions: [options.versions[0]] } : {}),
    ...(options.epics[0] ? { parent: { key: options.epics[0].key, summary: options.epics[0].summary } } : {}),
  };
  const link = buildCreateLink(config.siteUrl, draft, options.parentParam, await screenFieldIds(client, draft));
  if (!link.url) { fail(`Couldn't build a link: missing ${link.missing.join(", ")}`); return; }
  ok(`Fields: ${Object.keys(draft).join(", ")}`);
  link.warnings.forEach(warn);
  console.log(`\n  ${link.url}\n`);
  console.log("  Open it while signed in to Jira, compare the form with the fields above, and close it without pressing Create.");
}

main()
  .catch(error => fail(errorText(error)))
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
    process.exitCode = failures ? 1 : 0;
  });
