import { createHash } from 'node:crypto';

// Physical bounds are independent of work/authorization budgets. This first
// format preserves the existing synchronous domain model in a bounded snapshot.
export const SEGMENT_BYTES = 240000;
export const SNAPSHOT_BYTES = 32000000;
export const MAX_SEGMENTS = 4096;
export const FORMAT = 'dead-drop-segments-v1';
const hash = text => createHash('sha256').update(text).digest('hex');
const bytes = text => Buffer.byteLength(text);
export const segmentPath = digest => `segments/${digest.slice(0,2)}/${digest}.json`;
const digestPattern = /^[a-f0-9]{64}$/;

export function encodeSnapshot(state) {
  const serialized = JSON.stringify(state);
  if (bytes(serialized) > SNAPSHOT_BYTES) throw new Error('Mailbox snapshot exceeds 32 MB safety budget');
  const nodes = new Map();
  let visits=0;
  function put(node) {
    const text = JSON.stringify(node);
    if (bytes(text) > SEGMENT_BYTES) throw new Error('Storage segment exceeds safety budget');
    const digest = hash(text);
    nodes.set(digest, text);
    if (nodes.size > MAX_SEGMENTS) throw new Error('Mailbox exceeds segment-count safety budget');
    return digest;
  }
  function encode(value, depth = 0) {
    if (depth > 64 || ++visits>MAX_SEGMENTS) throw new Error('Mailbox nesting or segment-count exceeds safety budget');
    const leaf = {kind:'value', value};
    if (bytes(JSON.stringify(leaf)) <= SEGMENT_BYTES) return put(leaf);
    if (typeof value === 'string') {
      const parts=[];
      for(let i=0;i<value.length;i+=16000) parts.push(encode(value.slice(i,i+16000),depth+1));
      return put({kind:'text', parts});
    }
    if (Array.isArray(value)) {
      // Balanced immutable chunks: a changed record only replaces its path.
      const middle=Math.ceil(value.length/2);
      if(value.length===1) return put({kind:'array',items:[encode(value[0],depth+1)]});
      return put({kind:'concat',parts:[encode(value.slice(0,middle),depth+1),encode(value.slice(middle),depth+1)]});
    }
    if(value && typeof value==='object') {
      const entries=Object.entries(value);
      if(entries.length>1000) {
        const middle=Math.ceil(entries.length/2);
        return put({kind:'merge',parts:[encode(Object.fromEntries(entries.slice(0,middle)),depth+1),encode(Object.fromEntries(entries.slice(middle)),depth+1)]});
      }
      return put({kind:'object',entries:entries.map(([key,item])=>[key,encode(item,depth+1)])});
    }
    throw new Error('Unsupported large mailbox value');
  }
  // Normalize to JSON so undefined fields behave exactly like v1 storage.
  const root=encode(JSON.parse(serialized));
  return {manifest:{version:2,format:FORMAT,root,bytes:bytes(serialized)},nodes};
}

export async function decodeSnapshot(manifest, load) {
  if(manifest.version!==2 || manifest.format!==FORMAT || !digestPattern.test(manifest.root) ||
     !Number.isSafeInteger(manifest.bytes) || manifest.bytes<1 || manifest.bytes>SNAPSHOT_BYTES)
    throw new Error('Unsupported segmented mailbox manifest');
  let loadedBytes=0, visits=0;
  const ancestors=new Set();
  async function decode(digest,depth=0) {
    if(!digestPattern.test(digest)||depth>64||ancestors.has(digest)||++visits>MAX_SEGMENTS)
      throw new Error('Invalid or excessive mailbox segment graph');
    ancestors.add(digest);
    const text=await load(digest);
    if(typeof text!=='string'||bytes(text)>SEGMENT_BYTES||hash(text)!==digest)
      throw new Error('Mailbox segment integrity failure');
    loadedBytes+=bytes(text);
    if(loadedBytes>SNAPSHOT_BYTES*2)throw new Error('Mailbox segment read budget exceeded');
    const node=JSON.parse(text);
    let value;
    if(node.kind==='value' && Object.hasOwn(node,'value'))value=node.value;
    else if(node.kind==='object' && Array.isArray(node.entries)) {
      value={};
      for(const entry of node.entries) {
        if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||Object.hasOwn(value,entry[0]))throw new Error('Invalid mailbox object segment');
        Object.defineProperty(value,entry[0],{value:await decode(entry[1],depth+1),enumerable:true,writable:true,configurable:true});
      }
    } else if(node.kind==='array' && Array.isArray(node.items)) {
      value=[]; for(const child of node.items)value.push(await decode(child,depth+1));
    } else if(['concat','merge','text'].includes(node.kind)&&Array.isArray(node.parts)) {
      value=node.kind==='concat'?[]:node.kind==='text'?'':{};
      for(const child of node.parts) {
        const part=await decode(child,depth+1);
        if(node.kind==='concat') {if(!Array.isArray(part))throw new Error('Invalid array segment'); for(const item of part)value.push(item);}
        else if(node.kind==='text') {if(typeof part!=='string')throw new Error('Invalid text segment');value+=part;}
        else {
          if(!part||typeof part!=='object'||Array.isArray(part))throw new Error('Invalid object segment');
          for(const [key,item] of Object.entries(part)) {
            if(Object.hasOwn(value,key))throw new Error('Duplicate mailbox object key');
            Object.defineProperty(value,key,{value:item,enumerable:true,writable:true,configurable:true});
          }
        }
      }
    } else throw new Error('Unsupported mailbox segment');
    ancestors.delete(digest);
    if(bytes(JSON.stringify(value))>SNAPSHOT_BYTES)throw new Error('Decoded mailbox exceeds safety budget');
    return value;
  }
  const state=await decode(manifest.root);
  if(bytes(JSON.stringify(state))!==manifest.bytes)throw new Error('Mailbox snapshot size mismatch');
  return state;
}

export class SegmentedStorage {
  constructor(store,branch,file) {this.store=store;this.branch=branch;this.file=file;this.cache=new Map();this.cacheBytes=0;}
  async head() {return (await this.store.api(`repos/${this.store.repo}/git/ref/heads/${this.branch}`)).object.sha;}
  async privateRepo() {if(!(await this.store.api(`repos/${this.store.repo}`)).private)throw new Error('Mailbox disabled: repository is no longer private');}
  remember(digest,text) {
    if(this.cache.has(digest))return;
    while(this.cacheBytes+bytes(text)>SNAPSHOT_BYTES && this.cache.size) {
      const [key,old]=this.cache.entries().next().value;this.cache.delete(key);this.cacheBytes-=bytes(old);
    }
    this.cache.set(digest,text);this.cacheBytes+=bytes(text);
  }
  async readFile(path,head) {
    const file=await this.store.api(`repos/${this.store.repo}/contents/${path}?ref=${head}`);
    if(file.encoding!=='base64'||file.size>750000||typeof file.content!=='string'||file.content.length>1100000)throw new Error('Unsupported or oversized mailbox file');
    const text=Buffer.from(file.content,'base64').toString('utf8');
    if(bytes(text)>750000)throw new Error('Oversized mailbox file');
    return {text,sha:file.sha};
  }
  async read(head) {
    await this.privateRepo();
    head??=await this.head();
    const {text}=await this.readFile(this.file,head), manifest=JSON.parse(text);
    const reachable=new Set();
    const state=await decodeSnapshot(manifest,async digest=>{
      reachable.add(digest);
      if(this.cache.has(digest))return this.cache.get(digest);
      const {text}=await this.readFile(segmentPath(digest),head);
      if(hash(text)!==digest)throw new Error('Mailbox segment integrity failure');
      this.remember(digest,text);return text;
    });
    return {state,sha:{format:FORMAT,head,reachable}};
  }
  async publish(state,expected,{migration=false}={}) {
    if(state.version!==2||expected?.format!==FORMAT||!/^[a-f0-9]{40}$/.test(expected.head))throw new Error('Explicit mailbox migration required');
    const encoded=encodeSnapshot(state);
    await this.privateRepo();
    if(await this.head()!==expected.head)throw Object.assign(new Error('Mailbox revision changed'),{status:409});
    const parent=await this.store.api(`repos/${this.store.repo}/git/commits/${expected.head}`);
    const tree=[];
    for(const [digest,text] of encoded.nodes) {
      if(!expected.reachable?.has(digest)) {
        const blob=await this.store.api(`repos/${this.store.repo}/git/blobs`,'POST',{content:text,encoding:'utf-8'});
        tree.push({path:segmentPath(digest),mode:'100644',type:'blob',sha:blob.sha});
      }
    }
    // Only the new root is mutable. Old content-addressed files remain available
    // for snapshot reads/recovery; no automatic history deletion or Git rewrite.
    tree.push({path:this.file,mode:'100644',type:'blob',content:JSON.stringify(encoded.manifest)});
    const nextTree=await this.store.api(`repos/${this.store.repo}/git/trees`,'POST',{base_tree:parent.tree.sha,tree});
    const commit=await this.store.api(`repos/${this.store.repo}/git/commits`,'POST',{
      message:`${migration?'Migrate':'Update'} segmented development mailbox [skip ci]`,tree:nextTree.sha,parents:[expected.head],
    });
    await this.privateRepo();
    // A non-forced fast-forward is the only publication point. A concurrent
    // sibling commit cannot fast-forward, so readers never see a mixed snapshot.
    await this.store.api(`repos/${this.store.repo}/git/refs/heads/${this.branch}`,'PATCH',{sha:commit.sha,force:false});
    for(const [digest,text] of encoded.nodes)this.remember(digest,text);
    return {head:commit.sha,segments:encoded.nodes.size,bytes:encoded.manifest.bytes};
  }
}
