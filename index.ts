// redis-server /usr/local/etc/redis.conf --port 57413 --requirepass $REDIS_PASSWD --dir $(pwd)
import express from 'express';
import IORedis from 'ioredis';
type Db = IORedis.Redis;
export function setup(opts: IORedis.RedisOptions) { return new IORedis(opts); }
function toStreamKey(user: string, app: string) { return `stream/${user}/${app}`; }
function toUserKey(user: string) { return `tokens/${user}`; }
async function submitDiff(db: Db, user: string, app: string, payload: string) {
  return db.xadd(toStreamKey(user, app), '*', 'payload', payload);
}
async function getDiffsSince(db: Db, user: string, app: string, since: string = '-', count: number = 100) {
  return db.xrange(toStreamKey(user, app), since, '+', 'COUNT', count);
}
async function reqToUser(db: Db, req: express.Request) {
  const user = req.get('X-Redis-Family-User');
  const token = req.get('X-Redis-Family-Token');
  return (user && token && (await db.sismember(toUserKey(user), token))) ? user : '';
}
export function serve(db: Db, port: number) {
  const app = express();
  app.use(express.json());
  app.get('/', (_, res) => res.send('Post `{user, app, payload}` to here'));
  app.post('/', async (req, res) => {
    const {payload, user, app} = req.body as {[name: string]: string | undefined};
    const authUser = await reqToUser(db, req);
    if (!(user === authUser)) {
      res.sendStatus(401);
    } else if (payload && user && authUser && user === authUser && app) {
      res.sendStatus(200);
      submitDiff(db, user, app, payload);
    } else {
      res.sendStatus(400);
    }
  });
  app.get('/since', (_, res) => res.send('Post `{user, app, since}` to here'));
  app.post('/since', async (req, res) => {
    const {user, app, since} = req.body as {[name: string]: string | undefined};
    const authUser = await reqToUser(db, req);
    if (!(user === authUser)) {
      res.sendStatus(401);
    } else if (user && authUser && user === authUser && app) {
      res.json(await getDiffsSince(db, user, app, since || '-'));
    } else {
      res.sendStatus(400);
    }
  });
  return app.listen(port);
}