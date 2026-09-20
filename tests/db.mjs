import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
export class LocalD1 {
 constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec(fs.readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));}
 prepare(sql){const db=this;return new class {
 constructor(args=[]){this.args=args;this.sql=sql;}
 bind(...args){return new this.constructor(args);}
 execute(){const q=db.sqlite.prepare(sql);const results=q.all(...this.args);const meta=db.sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();return {success:true,results,meta};}
 async all(){return this.execute();}async run(){return this.execute();}async first(column){const r=this.execute().results[0]||null;return column?r?.[column]??null:r;}
 }();}
 async batch(statements){this.sqlite.exec('BEGIN');try{const r=statements.map(s=>s.execute());this.sqlite.exec('COMMIT');return r;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
 close(){this.sqlite.close();}
}
