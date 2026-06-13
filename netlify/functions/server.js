const serverless = require('serverless-http');
const app = require('../../server');

const handler = serverless(app);

exports.handler = (event, context) => {
  // Keep the pg pool alive between invocations instead of waiting for the
  // event loop to drain (which would hang on the open Postgres connections).
  context.callbackWaitsForEmptyEventLoop = false;
  return handler(event, context);
};
