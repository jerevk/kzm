export const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
export const all=async(env,sql,...args)=>(await stmt(env,sql,...args).all()).results;
export const first=(env,sql,...args)=>stmt(env,sql,...args).first();
