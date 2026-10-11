import { useEffect, useState } from "react";
import type { ProjectOptions, ProjectSummary } from "../../shared/special-group/types";
import { specialGroupApi } from "./api";

// Read-only Jira data for the draft card: the project list and one project's field options.

export function useProjects(enabled: boolean) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    specialGroupApi.projects().then(r => { if (live) { setProjects(r.projects); setError(""); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Couldn't load projects."); });
    return () => { live = false; };
  }, [enabled]);
  return { projects, error };
}

/** Field IDs on the chosen work type's create screen; null while unknown (the link then includes everything). */
export function useScreenFields(projectKey: string | undefined, typeId: string | undefined, enabled: boolean) {
  const [fields, setFields] = useState<string[] | null>(null);
  useEffect(() => {
    setFields(null);
    if (!enabled || !projectKey || !typeId) return;
    let live = true;
    specialGroupApi.screenFields(projectKey, typeId)
      .then(result => { if (live) setFields(result.fields.map(f => f.fieldId)); })
      .catch(() => { /* Unknown screen: build the full link rather than guess. */ });
    return () => { live = false; };
  }, [projectKey, typeId, enabled]);
  return fields;
}

export function useProjectOptions(projectKey: string | undefined, enabled: boolean) {
  const [options, setOptions] = useState<ProjectOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setOptions(null); setError("");
    if (!enabled || !projectKey) return;
    let live = true;
    setLoading(true);
    specialGroupApi.projectOptions(projectKey, nonce > 0)
      .then(result => { if (live) setOptions(result); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Couldn't load project options."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectKey, enabled, nonce]);
  return { options, loading, error, reload: () => setNonce(n => n + 1) };
}
