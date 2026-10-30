import { Router } from 'express';
import type { OpenApiDocument } from './builder';

// Pinned on purpose. Bump it deliberately and check the page still loads.
const SWAGGER_UI_VERSION = '5.17.14';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

// The rest of the API has default-src 'none'. Only this one page gets a looser policy.
const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Peacock Academy API</title>
    <link rel="stylesheet" href="${CDN}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${CDN}/swagger-ui-bundle.js"></script>
    <script src="/api/docs/init.js"></script>
  </body>
</html>`;

// Served as a file, so the page needs no inline script.
const INIT_JS = `window.ui = SwaggerUIBundle({
  url: '/api/docs/openapi.json',
  dom_id: '#swagger-ui',
  requestInterceptor: function (req) {
    var match = document.cookie.match(/(?:^|; )pa_csrf=([^;]+)/);
    if (match && ['GET', 'HEAD', 'OPTIONS'].indexOf(req.method) === -1) {
      req.headers['X-CSRF-Token'] = decodeURIComponent(match[1]);
    }
    return req;
  },
});
`;

export function createDocsRouter(document: OpenApiDocument): Router {
  const router = Router();

  // The raw spec file, deliberately not wrapped in the response envelope.
  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  router.get('/init.js', (_req, res) => {
    res.type('application/javascript').send(INIT_JS);
  });

  router.get('/', (_req, res) => {
    res.setHeader('Content-Security-Policy', DOCS_CSP);
    res.type('html').send(PAGE);
  });

  return router;
}