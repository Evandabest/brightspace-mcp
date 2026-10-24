export const setupGuide = {
  command: 'npm run setup',
  instructions: [
    'Run npm ci, npm run browser:install, then npm run setup in the brightspace-mcp project directory in your own terminal. Choose Browser login (recommended for students). Do not send passwords, tokens, or MFA codes to the assistant.',
    'Copy your school’s Brightspace URL from the browser address bar. For CUNY use https://brightspace.cuny.edu. A full Brightspace page URL is accepted; the wizard extracts the origin. Do not use your separate university SSO login host.',
    'Keep the default API versions unless your administrator specifies supported alternatives. No course IDs or OAuth application credentials are needed for browser mode.',
    'The wizard writes a private .env file, then offers to open Chromium. Complete your school sign-in and MFA yourself, navigate to the Brightspace homepage, then confirm in the terminal. Enrollment access is verified before the session is saved.',
    'Browser sessions are stored privately under ~/.brightspace-mcp/sessions/, bound to the exact Brightspace host. Passwords, MFA secrets, and SSO-provider cookies are not saved. This unofficial session integration may not work at every institution; CUNY live compatibility still requires testing.',
    'Start the server with node --env-file=.env dist/index.js or configure your MCP client with absolute paths. When prompted to sign in again, run npm run login. Run npm run logout to remove the locally saved session. Sessions are reloaded by tools without restarting the server; changing .env requires a restart.',
    'OAuth access-token mode is still available if your institution provides an approved registered application. Only that mode requires the scopes below and an access_token from an approved Authorization Code flow; the wizard masks the token. Browser login does not require copying a token.',
  ],
  scopes: ['enrollment:own_enrollment:read', 'dropbox:folders:read', 'grades:own_grades:read', 'content:toc:read'],
  oauth: {
    documentation: 'https://docs.valence.desire2learn.com/basic/oauth2.html',
    authorizationEndpoint: 'https://auth.brightspace.com/oauth2/auth',
    tokenEndpoint: 'https://auth.brightspace.com/core/connect/token',
  },
};
