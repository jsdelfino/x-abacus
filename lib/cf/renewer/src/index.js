'use strict';

const _ = require('underscore');
const compact = _.compact;
const extend = _.extend;
const every = _.every;
const first = _.first;
const flatten = _.flatten;
const findWhere = _.findWhere;
const groupBy = _.groupBy;
const head = _.head;
const map = _.map;
const memoize = _.memoize;
const pairs = _.pairs;
const pick = _.pick;
const tail = _.tail;

const util = require('util');

const batch = require('abacus-batch');
const breaker = require('abacus-breaker');
const cluster = require('abacus-cluster');
const dataflow = require('abacus-dataflow');
const dbclient = require('abacus-dbclient');
const moment = require('moment');
const oauth = require('abacus-oauth');
const perf = require('abacus-perf');
const request = require('abacus-request');
const retry = require('abacus-retry');
const router = require('abacus-router');
const seqid = require('abacus-seqid');
const throttle = require('abacus-throttle');
const urienv = require('abacus-urienv');
const usageSchemas = require('abacus-usage-schemas');
const webapp = require('abacus-webapp');
const yieldable = require('abacus-yieldable');

const reliableRequest = throttle(retry(breaker(batch(request))));

// Setup debug log
const debug = require('abacus-debug')('abacus-cf-renew');
const edebug = require('abacus-debug')('e-abacus-cf-renew');

// Create an express router
const routes = router();

// Resolve service URIs
const uris = memoize(() => urienv({
  api         : 80,
  collector   : 9080,
  db          : 5984,
  provisioning: 9880
}));

// Function call statistics
const statistics = {
  usage: {
    missingToken: 0,
    reportFailures: 0,
    reportSuccess: 0,
    reportConflict: 0
  },
  plan: {
    getFailures: 0,
    getSuccess: 0
  }
};

const oneDayInMilliseconds = 86400000;

// Use secure routes or not
const secured = process.env.SECURED === 'true';

// Abacus system token
const systemToken = secured ? oauth.cache(uris().api,
  process.env.CLIENT_ID, process.env.CLIENT_SECRET,
  'abacus.usage.write abacus.usage.read') :
  undefined;

// DB for storing the last processed app and app-usage GUIDs
const collectorDb = yieldable(throttle(retry(breaker(batch(
  dbclient(dataflow.partition(),
    dbclient.dburi(uris().db, 'abacus-collector-normalized-usage'))
)))));

const authHeader = (token) => token ? { authorization: token() } : {};

const reportUsage = (usage, token, cb) => {
  const t0 = Date.now();
  reliableRequest.post(':collector/v1/metering/collected/usage', {
    collector: uris().collector,
    headers: authHeader(token),
    body: usage
  }, (error, response) => {
    if (!error && response) {
      if (response.statusCode === 201) {
        debug('Successfully reported usage %j with headers %j',
          usage, response.headers);
        statistics.usage.reportSuccess++;
        perf.report('report', t0);
        cb();
        return;
      }
      if (response.statusCode === 409) {
        debug('Conflicting usage %j. Response: %j', usage, response);
        statistics.usage.reportConflict++;
        perf.report('report', t0, undefined, undefined, undefined, 'rejected');
        cb();
        return;
      }
    }
    const message = util.format('Failed reporting\n\tusage %j\n\terror %j' +
      '\n\tresponse %j', usage, error, response);
    edebug(message);
    statistics.usage.reportFailures++;
    perf.report('report', t0, undefined, new Error(error));
    cb(error, response);
  });
};

const moveToNextMonth = (usage) => {
  usage.start = moment(usage.start).add(1, 'month').valueOf();
  usage.end = moment(usage.end).add(1, 'month').valueOf();
  return usage;
};

const reportUsageDocuments = (docs, systemToken, { failure, success }) => {
  if (!docs || docs.length === 0) {
    debug('No more documents to process');
    success();
    return;
  }

  const usage = head(docs);
  reportUsage(moveToNextMonth(usage), systemToken, (error, response) => {
    if (error || response) {
      failure(error, response);
      return;
    }
    reportUsageDocuments(tail(docs), systemToken, { failure, success });
  });
};

const extractUsageDocs = (usageDocs) =>
  map(usageDocs, (usageDoc) => usageDoc.doc);

const resourceUsageSchemaProperties = map(
  pairs(usageSchemas.resourceUsage.json().properties), (p) => p[0]);

const pickUsageSchemaPropsOnly = (usageDocs) => map(usageDocs, (usageDoc) =>
    pick(usageDoc, resourceUsageSchemaProperties));

const getMeteringPlan = function *(meteringPlanId) {
  debug('Getting metering plan with id %s', meteringPlanId);

  const synchronousRequest = yieldable(reliableRequest);
  const response = yield synchronousRequest.get(
    ':provisioning/v1/metering/plans/:metering_plan_id',
    extend({}, authHeader(systemToken), {
      provisioning: uris().provisioning,
      cache: true,
      metering_plan_id: meteringPlanId
    }));

  // Unable to retrieve metering plan?
  if (response.statusCode !== 200) {
    const errorMessage = util.format('Unable to retrieve metering plan %s. ' +
      'Response: %j', meteringPlanId, response);
    edebug(errorMessage);
    throw new Error(errorMessage);
  }

  debug('Metering plan %s obtained', meteringPlanId);
  return response.body;
};

const filterTimeBasedUsage = function *(usageDocs) {
  debug('Filtering time-based docs in %d usage docs', usageDocs.length);
  const timeBasedMetrics = [];
  for (let doc of usageDocs) {
    const t0 = Date.now();
    try {
      const plan = yield getMeteringPlan(doc.metering_plan_id);
      statistics.plan.getSuccess++;
      perf.report('plan', t0);

      // Filter out plans with mixed (discrete and time-based) types
      // We know how to process only "pure" time-based plans
      if (every(plan.metrics, (metric) => metric.type === 'time-based'))
        timeBasedMetrics.push(doc);
      else
        debug('Plan %s contains mixed metric types. Filtering out usage doc %j',
          doc.metering_plan_id, doc);
    }
    catch (e) {
      statistics.plan.getFailures++;
      perf.report('plan', t0, undefined, new Error(e));
      throw e;
    }
  }

  debug('Selected %d time-based docs from %d usage documents',
    timeBasedMetrics.length, usageDocs.length);
  return timeBasedMetrics;
};

const buildKey = (doc) => util.format('%s/%s/%s/%s/%s/%s/%s',
  doc.organization_id, doc.event, doc.space_id, doc.consumer_id,
  doc.resource_id, doc.plan_id, doc.resource_instance_id);

const stalledCriteria = { measure: 'current_instance_memory', quantity: 0 };

// We expect usageDocs to be ordered **descending**. This is guaranteed by
// dbclient.allDocs
const removeStalledUsage = (usageDocs) => {
  debug('Will scan %d usage docs for stalled usage', usageDocs.length);

  const groups = groupBy(usageDocs, (doc) => buildKey(doc));
  debug('Split usage docs in %d groups', Object.keys(groups).length);

  const noStalledUsage = compact(map(groups, (group) => {
    const latestUsage = first(group);
    if (!latestUsage.resource_id.endsWith('linux-container')) {
      debug('Ignoring unknown resource id %s', latestUsage.resource_id);
      return undefined;
    }
    if (findWhere(latestUsage.measured_usage, stalledCriteria)) {
      debug('Found stalled usage %j', latestUsage);
      return undefined;
    }
    return latestUsage;
  }));

  // Get rid of the group keys
  const normalizedUsageDocs = flatten(map(noStalledUsage, (doc) => doc));
  debug('Removed %d usage documents in total',
    usageDocs.length - normalizedUsageDocs.length);
  return normalizedUsageDocs;
};

const setRenewTimeout = (fn , interval) => {
  clearTimeout(module.usageRenewer);
  module.usageRenewer = setTimeout(fn, interval);
  debug('Reporting interval set to %d ms', interval);
};

const renewUsage = (systemToken, { failure, success }) => {
  debug('Usage renew started ...');

  if (secured && !systemToken()) {
    edebug('Missing token');
    setRenewTimeout(() => renewUsage(systemToken,
      { failure: failure, success: success }), 5000);
    statistics.usage.missingToken++;
    failure('Missing token');
    return;
  }

  debug('Scheduling next execution on %s',
    moment().add(oneDayInMilliseconds, 'milliseconds').toDate());
  module.usageRenewer = setTimeout(() => renewUsage(systemToken,
    { failure, success }), oneDayInMilliseconds);

  yieldable.functioncb(function *() {
    // Calculate previous month boundaries
    const startOfPreviousMonth =
      moment().utc().subtract(1, 'months').startOf('month');
    const endOfPreviousMonth =
      moment().utc().subtract(1, 'months').endOf('month');
    debug('Will scan for usage between %s and %s',
      startOfPreviousMonth.toISOString(), endOfPreviousMonth.toISOString());

    // Compute the query range
    const startId = dbclient.tkuri('',
      seqid.pad16(startOfPreviousMonth.valueOf()));
    const endId = dbclient.tkuri('',
      seqid.pad16(endOfPreviousMonth.valueOf()));
    debug('Searching for docs in the range [%s, %s)', startId, endId);

    // Fetch all docs from the previous month
    const docs = yield collectorDb.allDocs({
      include_docs: true,
      descending: true,
      endkey: startId,
      startkey: endId
    });
    debug('Found %d DB documents ...', docs.rows.length);

    // Filter the docs
    const usageDocs = extractUsageDocs(docs.rows);
    const timeBasedDocs = yield filterTimeBasedUsage(usageDocs);
    const usageSchemaDocs = pickUsageSchemaPropsOnly(timeBasedDocs);
    return removeStalledUsage(usageSchemaDocs);
  })((error, docs) => {
    if (error) {
      failure(error);
      return;
    }

    debug('Will process %d documents ...', docs.length);
    reportUsageDocuments(docs, systemToken, { failure, success });
  });
};

const stopRenewer = (cb = () => {}) => {
  edebug('Cancelling timers');
  clearTimeout(module.usageRenewer);

  if (typeof cb === 'function')
    cb();
};

const startRenewer = function *() {
  debug('Starting renewer ...');

  // Start token functions
  if (secured)
    systemToken.start();

  setRenewTimeout(function *() {
    yield renewUsage(systemToken, {
      success: () => {
        debug('Renewer completed successfully');
      },
      failure: (err) => {
        debug('Renewer failed due to %j', err);
      }
    });
  }, 0);

  // Cancel scheduled timers
  process.on('exit', stopRenewer);
};

routes.get('/v1/cf/renewer', throttle(function *(req) {
  return {
    body: {
      renewer: {
        performance: {
          report: perf.stats('report'),
          plan: perf.stats('plan')
        },
        statistics: statistics
      }
    }
  };
}));

// Create a CF renew app
const renew = () => {
  debug('Starting renew app ...');
  cluster.singleton();

  if (cluster.isWorker()) {
    debug('Starting renew worker');
    yieldable(() => startRenewer());
  }

  // Create the Webapp
  const app = webapp();

  if(secured)
    app.use(routes, oauth.validator(process.env.JWTKEY, process.env.JWTALGO));
  else
    app.use(routes);

  return app;
};

// Command line interface, create the renew app and listen
const runCLI = () => renew().listen();

// Export our public functions
module.exports = renew;
module.exports.statistics = statistics;
module.exports.resourceUsageSchemaProperties = resourceUsageSchemaProperties;
module.exports.stopRenewer = stopRenewer;
module.exports.renewUsage = renewUsage;
module.exports.removeStalledUsage = removeStalledUsage;
module.exports.filterTimeBasedUsage = filterTimeBasedUsage;
module.exports.runCLI = runCLI;
