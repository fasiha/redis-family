// redis-server /usr/local/etc/redis.conf --port 57413 --requirepass $REDIS_PASSWD --dir $(pwd)
import express from 'express';
import IORedis from 'ioredis';
type Db = IORedis.Redis;
const DEFAULTSEPARATOR = '/';
export function setup(opts: IORedis.RedisOptions) { return new IORedis(opts); }
function toOpaqueKey(user: string, app: string, opaque: string) { return `opaque/${user}/${app}/${opaque}`; }
function toDiffZkey(user: string, app: string) { return `diff/${user}/${app}` }
function toUserKey(user: string) { return `tokens/${user}`; }
export async function submitDiff(db: Db, user: string, app: string, payload: string, opaque: string) {
  const luaScript = `return {redis.call('zadd', KEYS[1], 'NX', redis.call('zcard', KEYS[1]), ARGV[1]),
redis.call('set', KEYS[2], ARGV[2])}`;
  return db.eval(luaScript, 2, toDiffZkey(user, app), toOpaqueKey(user, app, opaque), opaque, payload);
}
export function opaqueRankCard(db: Db, user: string, app: string, opaque: string) {
  const zsetKey = toDiffZkey(user, app);
  return db.multi().zrank(zsetKey, opaque).zcard(zsetKey).exec();
}
export function lastDiffsOpaques(db: Db, user: string, app: string, n: number) {
  return db.zrevrange(toDiffZkey(user, app), -Math.abs(n), -1);
}
export function numDiffs(db: Db, user: string, app: string) { return db.zcard(toDiffZkey(user, app)); }
export function opaqueToPayload(db: Db, user: string, app: string, opaque: string) {
  return db.get(toOpaqueKey(user, app, opaque));
}
async function reqToUser(db: Db, req: express.Request) {
  const user = req.get('X-Redis-Family-User');
  const token = req.get('X-Redis-Family-Token');
  return (user && token && (await db.sismember(toUserKey(user), token))) ? user : '';
}
export function serve(db: Db, port: number) {
  const app = express();
  app.use(express.json());
  app.get('/', (req, res) => res.send('Post `{user, app, payload, opaque}` to here'));
  app.post('/', async (req, res) => {
    const {payload, user, app, opaque} = req.body as {[name: string]: string | undefined};
    const authUser = await reqToUser(db, req);
    if (!(user === authUser)) {
      res.sendStatus(401);
    } else if (payload && user && authUser && user === authUser && app && opaque) {
      res.sendStatus(200);
      submitDiff(db, user, app, payload, opaque);
    } else {
      res.sendStatus(400);
    }
  });
  app.get('/my-latest', (req, res) => res.send('Post `{user, app, opaque}` to here'));
  app.post('/my-latest', async (req, res) => {
    const {user, app, opaque} = req.body as {[name: string]: string | undefined};
    const authUser = await reqToUser(db, req);
    if (!(user === authUser)) {
      res.sendStatus(401);
    } else if (user && authUser && user === authUser && app && opaque) {
      let [[_, rank], [__, card]] = await opaqueRankCard(db, user, app, opaque);
      res.json([rank, card]);
    } else {
      res.sendStatus(400);
    }
  });
  return app.listen(port, () => console.log(`# Express listening on port ${port}!`));
}