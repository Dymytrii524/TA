import pg from 'pg';
// Test-only destructive setup is restricted to a dedicated local database.
export async function postgresFixtureDB(){
  const url=new URL(process.env.WEB3_TEST_DATABASE_URL??'');
  if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/ta_web3_test')
    throw Error('dedicated LOCAL ta_web3_test database required');
  const pool=new pg.Pool({connectionString:url.href,max:6});
  const adapter={
    query:(...args)=>pool.query(...args),exec:sql=>pool.query(sql),close:()=>pool.end(),
    transaction:async fn=>{
      for(let attempt=0;;attempt++){
        const c=await pool.connect();
        try{
          await c.query('BEGIN');
          await c.query("SET LOCAL lock_timeout='5s'");
          const result=await fn({query:(...args)=>c.query(...args),exec:sql=>c.query(sql)});
          await c.query('COMMIT');return result;
        }catch(e){
          await c.query('ROLLBACK');
          if(!['40001','40P01'].includes(e.code)||attempt>=2)throw e;
        }finally{c.release()}
      }
    }
  };
  await adapter.exec('DROP SCHEMA IF EXISTS web3 CASCADE; DROP TABLE IF EXISTS public.users,public.companies CASCADE');
  return adapter;
}
