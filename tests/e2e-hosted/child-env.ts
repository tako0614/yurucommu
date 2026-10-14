// Local test child: return only assertions, never the environment values.
console.log(
  JSON.stringify({
    endpointIsStaging:
      process.env.TAKOFORM_ENDPOINT === "https://api-staging.takoserver.com",
    credentialsPresent: Boolean(
      process.env.TAKOFORM_TOKEN && process.env.TAKOFORM_EVIDENCE_TOKEN,
    ),
    cloudflareCredentialsAbsent: !process.env.CLOUDFLARE_API_TOKEN,
    terraformOverridesAbsent:
      !process.env.TF_VAR_project_name && !process.env.TF_CLI_CONFIG_FILE,
    argvSecretAbsent: !process.argv.some((argument) =>
      argument.includes("secret-canary"),
    ),
  }),
);
