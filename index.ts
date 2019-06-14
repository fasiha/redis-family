// redis-server /usr/local/etc/redis.conf --port 57413 --requirepass $REDIS_PASSWD --dir $(pwd)
import express from 'express';
import IORedis from 'ioredis';
type Db = IORedis.Redis;
const DEFAULTSEPARATOR = '/';
export function setup(opts: IORedis.RedisOptions) { return new IORedis(opts); }
export async function submitDiff(db: Db, user: string, app: string, payload: string, opaque: string) {
  const zsetKey = ['data', user, app, 'diffs'].join(DEFAULTSEPARATOR);
  const opaqueKey = ['data', user, app, 'opaques', opaque].join(DEFAULTSEPARATOR);
  const num = (await db.zcard(zsetKey)) || -1;
  return db.multi().zadd(zsetKey, 'NX', (num + 1).toString(), opaque).set(opaqueKey, payload).exec();
}
export function opaqueRank(db: Db, user: string, app: string, opaque: string) {
  const zsetKey = ['data', user, app, 'diffs'].join(DEFAULTSEPARATOR);
  return db.multi().zrank(zsetKey, opaque).zcard(zsetKey).exec();
}
export function lastDiffsOpaques(db: Db, user: string, app: string, n: number) {
  return db.zrevrange(['data', user, app, 'diffs'].join(DEFAULTSEPARATOR), -Math.abs(n), -1);
}
export function numDiffs(db: Db, user: string, app: string) {
  return db.zcard(['data', user, app, 'diffs'].join(DEFAULTSEPARATOR));
}
export function opaqueToPayload(db: Db, user: string, app: string, opaque: string) {
  return db.get(['data', user, app, 'opaques', opaque].join(DEFAULTSEPARATOR));
}
async function reqToUser(db: Db, req: express.Request) {
  const user = req.get('X-Redis-Family-User');
  const token = req.get('X-Redis-Family-Token');
  if (user && token && (await db.sismember(['tokens', user].join(DEFAULTSEPARATOR), token))) { return user; }
  return '';
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
  app.get('/do-i-have-the-latest', (req, res) => res.send('Post `{user, app, opaque}` to here'));
  app.post('/do-i-have-the-latest', async (req, res) => {
    const {user, app, opaque} = req.body as {[name: string]: string | undefined};
    const authUser = await reqToUser(db, req);
    if (!(user === authUser)) {
      res.sendStatus(401);
    } else if (user && authUser && user === authUser && app && opaque) {
      let res = await opaqueRank(db, user, app, opaque);
    } else {
      res.sendStatus(400);
    }
  });
  return app.listen(port, () => console.log(`Express listening on port ${port}!`));
}