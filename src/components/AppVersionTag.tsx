import { useConfig } from "../contexts/ConfigContext";

/** What the server runs, at the foot of the sidebar: "v1.0.0 · b6d9e99 · Nov 12". */
export function AppVersionTag() {
  const { config } = useConfig();
  const version = config?.version;
  if (!version) return null;
  const deployed = version.deployedAt ? new Date(version.deployedAt) : undefined;
  const details = [
    `Gemini Prep ${version.version}`,
    version.commit ? `commit ${version.commit}` : undefined,
    deployed ? `deployed ${deployed.toLocaleString()}` : "running locally",
  ].filter(Boolean).join(" · ");
  return (
    <p className="version-tag" title={details}>
      <span>v{version.version}</span>
      {version.commit ? (
        <>
          <span aria-hidden="true">·</span>
          {version.commitUrl ? (
            <a href={version.commitUrl} target="_blank" rel="noreferrer">{version.commit}</a>
          ) : (
            <span className="version-commit">{version.commit}</span>
          )}
        </>
      ) : null}
      {deployed && version.deployedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <time dateTime={version.deployedAt}>{deployed.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
        </>
      ) : null}
    </p>
  );
}
