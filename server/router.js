'use strict';
const { json, fail, ApiError } = require('./util');

/** Mini-routeur HTTP (zéro dépendance) : /api/reservations/:id */
function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }).replace(/\//g, '\\/') + '/?$');
    routes.push({ method: method.toUpperCase(), regex, keys, handler, pattern });
  }

  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  async function handle(req, res, pathname, query, extra) {
    const found = match(req.method, pathname);
    if (!found) return false;
    const ctx = Object.assign({ req, res, params: found.params, query, path: pathname }, extra || {});
    try {
      await found.route.handler(ctx);
    } catch (e) {
      if (res.headersSent) {
        try { res.end(); } catch (e2) { /* ignore */ }
        return true;
      }
      const mapped = require('./auth').mapDbError(e);
      fail(res, mapped || e);
    }
    return true;
  }

  return { add, match, handle, routes };
}

function ok(res, data) { return json(res, 200, data === undefined ? {} : data); }
function created(res, data) { return json(res, 201, data); }
function noContent(res) { res.writeHead(204); res.end(); }

module.exports = { createRouter, ok, created, noContent, ApiError };
