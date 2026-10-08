# Authentication

Status: design. Implementation is Phase 2. Interface: `JiraAuthProvider` in `src/jira/auth/types.ts`.
No authentication method exists in Phase 0, and none is simulated.

## Provider abstraction

```ts
interface JiraAuthProvider {
  readonly method: 'api-token' | 'oauth';
  status(): Promise<JiraAuthStatus>;
  login(prompter: Prompter): Promise<JiraAuthStatus>;
  logout(): Promise<boolean>;
  authorize(): Promise<JiraAuthorization>; // { apiBaseUrl, headers.Authorization }
}
```

`JiraAuthorization` is only handed to the HTTP layer. It is never logged, persisted, or included in any
data sent to Claude.

## Personal use: Jira Cloud API token (Phase 2)

- The user provides the site URL, account email, and an API token created at
  `id.atlassian.com`.
- `login` validates the credentials with a read-only call (current user) before storing anything.
- The token is stored in the OS credential store (`CredentialStore`, service `git2jira-ai`). The site URL
  and auth method go into the global config; the email is part of the credential account name.
- Requests use HTTP Basic authentication (`email:token`) over HTTPS.
- If no secure credential backend is available (for example a headless Linux box without Secret
  Service), login fails with a clear message. There is **no plaintext fallback**.

To verify during Phase 2 against Atlassian's current documentation:

- Classic vs. scoped API tokens, the base URL each requires (site URL vs. `api.atlassian.com/ex/jira/{cloudId}`),
  and the minimum scopes (read issue, read comments, write comments).
- Token expiry rules and how to surface an expired token (`JiraAuthStatus.expired`).

## Public distribution: OAuth (later)

OAuth is a designed extension point, not a commitment to a particular flow.

Fixed constraints:

- **No confidential client secret is ever embedded in distributed software.** A secret shipped in an npm
  package is public.
- PKCE alone does not make a native, distributed client compliant. What matters is which grant types and
  client types Atlassian actually supports for this app type, and its distribution requirements.

Candidate architectures, to be evaluated in the authentication phase:

1. **Public-client authorization code flow with PKCE**, only if Atlassian supports public clients without
   a secret for this app type at that time.
2. **Token-exchange broker**: a small service operated by the project that holds the client secret and
   performs code exchange and refresh. The CLI never sees the secret. This adds hosting, privacy, and
   operational responsibilities that must be accepted explicitly.
3. **An Atlassian platform app** (for example Forge), if the platform's distribution model fits.

Evaluation checklist: supported grants and client types, redirect URI rules for localhost loopback,
refresh-token rotation, required scopes, app review/distribution requirements, and data-residency
implications.

## Logout and uninstall

`logout` deletes the credential from the OS store and reports whether anything was removed. `uninstall`
(Phase 5) also removes it.
