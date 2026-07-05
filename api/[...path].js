const { handleApi } = require('../lib/api-handler');

module.exports = async function handler(req, res) {
  const pathname = req.url.split('?')[0];
  return handleApi(req, res, pathname);
};
