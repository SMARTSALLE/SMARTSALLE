'use strict';

module.exports = function mountRoutes(router) {
  require('./auth')(router);
  /* modules.js doit être monté AVANT catalog.js : ses routes /api/modules et
     /api/teachers appliquent le filtrage par options approuvées (permissions
     serveur) et prennent le pas sur les versions génériques de catalog.js. */
  require('./modules')(router);
  require('./catalog')(router);
  require('./reservations')(router);
  require('./admin')(router);
  require('./personal')(router);
  require('./absences')(router);
  require('./exports')(router);
};
