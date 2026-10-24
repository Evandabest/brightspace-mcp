export const setupGuide = {
  command: 'npm run setup',
  instructions: [
    'Run npm run setup in the brightspace-mcp project directory in your own terminal. Do not send tokens or passwords to the assistant.',
    'Sign in to Brightspace in your browser. Copy the origin from the address bar, for example https://learn.your-school.edu. The wizard also accepts a full Brightspace page URL and extracts the origin. Do not use your separate university SSO login host.',
    'Obtain an OAuth access token for your own student account through an institution-approved registered application using the Authorization Code grant. The token is the access_token value in the OAuth token response, not your password, browser cookie, client secret, or authorization code.',
    'If you do not have an approved application, contact your campus LMS/Brightspace administrator. Ask them to register or approve a student-facing Authorization Code application in Manage Extensibility > OAuth 2.0 and provide an approved authorization flow. Ordinary student accounts generally cannot register applications.',
    'An administrator registers the application with a redirect URI matching the approved OAuth client and the four scopes listed below. Use that client to sign in, grant consent, and obtain your personal access token. This project does not yet perform that browser flow or exchange client credentials for tokens.',
    'Keep the default API versions unless your administrator specifies supported alternatives. No course IDs are needed during setup; get_courses retrieves them after connecting.',
    'The terminal wizard masks your token, validates the configuration, optionally checks enrollment access, and writes a private .env file. It asks before replacing an existing file. Restart your MCP client after setup or token replacement.',
  ],
  scopes: ['enrollment:own_enrollment:read', 'dropbox:folders:read', 'grades:own_grades:read', 'content:toc:read'],
  oauth: {
    documentation: 'https://docs.valence.desire2learn.com/basic/oauth2.html',
    authorizationEndpoint: 'https://auth.brightspace.com/oauth2/auth',
    tokenEndpoint: 'https://auth.brightspace.com/core/connect/token',
  },
};
