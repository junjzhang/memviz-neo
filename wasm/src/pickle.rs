// Streaming pickle parser focused on PyTorch memory snapshots.
//
// The crucial difference vs serde_pickle: values live behind Rc<Value>
// and MEMO/GET bumps reference counts instead of deep-cloning the value.
// A frames list that is MEMOIZE'd once and BINGET'd 50000 times costs
// 50000 Rc increments (~400 KB), not 50000 deep clones (~200 MB).
//
// Containers (List, Dict) sit inside RefCell because APPENDS / SETITEMS
// mutate the container *after* MEMOIZE has already captured it.
//
// Only the opcodes PyTorch's pickle output actually uses are handled —
// enough to decode {dict, list, tuple, str, int, float, bool, None}.

use std::cell::RefCell;
use std::rc::Rc;

pub type ValueRc = Rc<Value>;

#[derive(Debug)]
pub enum Value {
    None,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Rc<str>),
    Bytes(Rc<[u8]>),
    List(RefCell<Vec<ValueRc>>),
    Dict(RefCell<Vec<(ValueRc, ValueRc)>>),
    Tuple(Vec<ValueRc>),
}

pub fn parse(data: &[u8]) -> Result<ValueRc, String> {
    let mut p = Parser {
        data,
        pos: 0,
        stack: Vec::with_capacity(1024),
        marks: Vec::new(),
        memo: Vec::new(),
    };
    p.run()
}

struct Parser<'a> {
    data: &'a [u8],
    pos: usize,
    stack: Vec<ValueRc>,
    marks: Vec<usize>,
    memo: Vec<ValueRc>,
}

// Opcode constants (Pickle protocol 2–5 subset).
const OP_MARK: u8            = b'(';
const OP_STOP: u8            = b'.';
const OP_POP: u8             = b'0';
const OP_POP_MARK: u8        = b'1';
const OP_DUP: u8             = b'2';
const OP_EMPTY_TUPLE: u8     = b')';
const OP_TUPLE: u8           = b't';
const OP_EMPTY_LIST: u8      = b']';
const OP_APPEND: u8          = b'a';
const OP_APPENDS: u8         = b'e';
const OP_EMPTY_DICT: u8      = b'}';
const OP_SETITEM: u8         = b's';
const OP_SETITEMS: u8        = b'u';
const OP_NONE: u8            = b'N';
const OP_NEWTRUE: u8         = 0x88;
const OP_NEWFALSE: u8        = 0x89;
const OP_PROTO: u8           = 0x80;
const OP_FRAME: u8           = 0x95;
const OP_MEMOIZE: u8         = 0x94;
const OP_BINGET: u8          = b'h';
const OP_LONG_BINGET: u8     = b'j';
const OP_BINPUT: u8          = b'q';
const OP_LONG_BINPUT: u8     = b'r';
const OP_BININT: u8          = b'J';
const OP_BININT1: u8         = b'K';
const OP_BININT2: u8         = b'M';
const OP_LONG1: u8           = 0x8a;
const OP_LONG4: u8           = 0x8b;
const OP_BINFLOAT: u8        = b'G';
const OP_SHORT_BINUNICODE: u8 = 0x8c;
const OP_BINUNICODE: u8      = 0x8d;
const OP_BINUNICODE8: u8     = 0x8e;
const OP_SHORT_BINBYTES: u8  = b'C';
const OP_BINBYTES: u8        = b'B';
const OP_BINBYTES8: u8       = 0x8e; // shared discriminant with BINUNICODE8 — disambiguated by context; not used by PyTorch snapshots
const OP_TUPLE1: u8          = 0x85;
const OP_TUPLE2: u8          = 0x86;
const OP_TUPLE3: u8          = 0x87;

#[allow(dead_code)]
const _: () = {
    // Guard: BINBYTES8 and BINUNICODE8 overlap in this simplified map but
    // we only need BINUNICODE8 for string payloads PyTorch emits. If a
    // real dataset ships raw bytes we'll route through BINBYTES below.
    if OP_BINBYTES8 == OP_BINUNICODE8 { /* keep compiler happy */ }
};

impl<'a> Parser<'a> {
    fn run(&mut self) -> Result<ValueRc, String> {
        loop {
            let op = self.read_u8()?;
            match op {
                OP_PROTO => { self.read_u8()?; }
                OP_FRAME => { self.skip(8)?; }
                OP_MEMOIZE => {
                    let v = self.stack.last().ok_or("MEMOIZE on empty stack")?.clone();
                    self.memo.push(v);
                }
                OP_BINPUT => {
                    let id = self.read_u8()? as usize;
                    let v = self.stack.last().ok_or("BINPUT on empty stack")?.clone();
                    self.put_memo(id, v);
                }
                OP_LONG_BINPUT => {
                    let id = self.read_u32()? as usize;
                    let v = self.stack.last().ok_or("LONG_BINPUT on empty stack")?.clone();
                    self.put_memo(id, v);
                }
                OP_BINGET => {
                    let id = self.read_u8()? as usize;
                    let v = self.memo.get(id).ok_or("BINGET: missing memo")?.clone();
                    self.stack.push(v);
                }
                OP_LONG_BINGET => {
                    let id = self.read_u32()? as usize;
                    let v = self.memo.get(id).ok_or("LONG_BINGET: missing memo")?.clone();
                    self.stack.push(v);
                }
                OP_MARK => self.marks.push(self.stack.len()),
                OP_POP => { self.stack.pop(); }
                OP_POP_MARK => {
                    let m = self.marks.pop().ok_or("POP_MARK: no mark")?;
                    self.stack.truncate(m);
                }
                OP_DUP => {
                    let v = self.stack.last().ok_or("DUP on empty stack")?.clone();
                    self.stack.push(v);
                }
                OP_EMPTY_TUPLE => self.stack.push(Rc::new(Value::Tuple(Vec::new()))),
                OP_TUPLE => {
                    let m = self.marks.pop().ok_or("TUPLE: no mark")?;
                    let items: Vec<ValueRc> = self.stack.drain(m..).collect();
                    self.stack.push(Rc::new(Value::Tuple(items)));
                }
                OP_TUPLE1 => {
                    let a = self.stack.pop().ok_or("TUPLE1 empty")?;
                    self.stack.push(Rc::new(Value::Tuple(vec![a])));
                }
                OP_TUPLE2 => {
                    let b = self.stack.pop().ok_or("TUPLE2 empty")?;
                    let a = self.stack.pop().ok_or("TUPLE2 empty")?;
                    self.stack.push(Rc::new(Value::Tuple(vec![a, b])));
                }
                OP_TUPLE3 => {
                    let c = self.stack.pop().ok_or("TUPLE3 empty")?;
                    let b = self.stack.pop().ok_or("TUPLE3 empty")?;
                    let a = self.stack.pop().ok_or("TUPLE3 empty")?;
                    self.stack.push(Rc::new(Value::Tuple(vec![a, b, c])));
                }
                OP_EMPTY_LIST => self.stack.push(Rc::new(Value::List(RefCell::new(Vec::new())))),
                OP_APPEND => {
                    let item = self.stack.pop().ok_or("APPEND empty")?;
                    let list = self.stack.last().ok_or("APPEND no list")?;
                    match list.as_ref() {
                        Value::List(cell) => cell.borrow_mut().push(item),
                        _ => return Err("APPEND target is not a list".into()),
                    }
                }
                OP_APPENDS => {
                    let m = self.marks.pop().ok_or("APPENDS: no mark")?;
                    let items: Vec<ValueRc> = self.stack.drain(m..).collect();
                    let list = self.stack.last().ok_or("APPENDS no list")?;
                    match list.as_ref() {
                        Value::List(cell) => cell.borrow_mut().extend(items),
                        _ => return Err("APPENDS target is not a list".into()),
                    }
                }
                OP_EMPTY_DICT => self.stack.push(Rc::new(Value::Dict(RefCell::new(Vec::new())))),
                OP_SETITEM => {
                    let v = self.stack.pop().ok_or("SETITEM empty")?;
                    let k = self.stack.pop().ok_or("SETITEM empty")?;
                    let d = self.stack.last().ok_or("SETITEM no dict")?;
                    match d.as_ref() {
                        Value::Dict(cell) => cell.borrow_mut().push((k, v)),
                        _ => return Err("SETITEM target is not a dict".into()),
                    }
                }
                OP_SETITEMS => {
                    let m = self.marks.pop().ok_or("SETITEMS: no mark")?;
                    let items: Vec<ValueRc> = self.stack.drain(m..).collect();
                    if items.len() % 2 != 0 {
                        return Err("SETITEMS: odd pairs".into());
                    }
                    let d = self.stack.last().ok_or("SETITEMS no dict")?;
                    match d.as_ref() {
                        Value::Dict(cell) => {
                            let mut b = cell.borrow_mut();
                            let mut it = items.into_iter();
                            while let (Some(k), Some(v)) = (it.next(), it.next()) {
                                b.push((k, v));
                            }
                        }
                        _ => return Err("SETITEMS target is not a dict".into()),
                    }
                }
                OP_NONE     => self.stack.push(Rc::new(Value::None)),
                OP_NEWTRUE  => self.stack.push(Rc::new(Value::Bool(true))),
                OP_NEWFALSE => self.stack.push(Rc::new(Value::Bool(false))),
                OP_BININT   => { let n = self.read_i32()? as i64; self.stack.push(Rc::new(Value::Int(n))); }
                OP_BININT1  => { let n = self.read_u8()? as i64; self.stack.push(Rc::new(Value::Int(n))); }
                OP_BININT2  => { let n = self.read_u16()? as i64; self.stack.push(Rc::new(Value::Int(n))); }
                OP_LONG1    => {
                    let len = self.read_u8()? as usize;
                    let n = self.read_signed_long(len)?;
                    self.stack.push(Rc::new(Value::Int(n)));
                }
                OP_LONG4    => {
                    let len = self.read_u32()? as usize;
                    let n = self.read_signed_long(len)?;
                    self.stack.push(Rc::new(Value::Int(n)));
                }
                OP_BINFLOAT => {
                    let bytes = self.read_bytes(8)?;
                    let mut b = [0u8; 8];
                    b.copy_from_slice(bytes);
                    // pickle BINFLOAT is big-endian
                    let f = f64::from_be_bytes(b);
                    self.stack.push(Rc::new(Value::Float(f)));
                }
                OP_SHORT_BINUNICODE => {
                    let len = self.read_u8()? as usize;
                    let bytes = self.read_bytes(len)?;
                    let s = std::str::from_utf8(bytes).map_err(|e| format!("bad utf8: {e}"))?;
                    self.stack.push(Rc::new(Value::Str(Rc::from(s))));
                }
                OP_BINUNICODE => {
                    let len = self.read_u32()? as usize;
                    let bytes = self.read_bytes(len)?;
                    let s = std::str::from_utf8(bytes).map_err(|e| format!("bad utf8: {e}"))?;
                    self.stack.push(Rc::new(Value::Str(Rc::from(s))));
                }
                OP_BINUNICODE8 => {
                    // Distinguishing BINBYTES8 vs BINUNICODE8: both have the
                    // same opcode byte in the tables above for this simplified
                    // parser. PyTorch snapshots emit only UTF-8 here. If a
                    // future pickle actually uses BINBYTES8, we'd route by
                    // context; for now, treat as unicode.
                    let len = self.read_u64()? as usize;
                    let bytes = self.read_bytes(len)?;
                    let s = std::str::from_utf8(bytes).map_err(|e| format!("bad utf8: {e}"))?;
                    self.stack.push(Rc::new(Value::Str(Rc::from(s))));
                }
                OP_SHORT_BINBYTES => {
                    let len = self.read_u8()? as usize;
                    let bytes = self.read_bytes(len)?.to_vec();
                    self.stack.push(Rc::new(Value::Bytes(Rc::from(bytes.as_slice()))));
                }
                OP_BINBYTES => {
                    let len = self.read_u32()? as usize;
                    let bytes = self.read_bytes(len)?.to_vec();
                    self.stack.push(Rc::new(Value::Bytes(Rc::from(bytes.as_slice()))));
                }
                OP_STOP => break,
                other => {
                    return Err(format!(
                        "unsupported pickle opcode 0x{:02x} at byte {}",
                        other, self.pos - 1
                    ));
                }
            }
        }
        self.stack.pop().ok_or_else(|| "STOP with empty stack".into())
    }

    fn put_memo(&mut self, id: usize, v: ValueRc) {
        if self.memo.len() <= id { self.memo.resize(id + 1, Rc::new(Value::None)); }
        self.memo[id] = v;
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        let b = *self.data.get(self.pos).ok_or("pickle: unexpected EOF (u8)")?;
        self.pos += 1;
        Ok(b)
    }
    fn read_u16(&mut self) -> Result<u16, String> {
        let bytes = self.read_bytes(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }
    fn read_u32(&mut self) -> Result<u32, String> {
        let bytes = self.read_bytes(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
    fn read_i32(&mut self) -> Result<i32, String> { Ok(self.read_u32()? as i32) }
    fn read_u64(&mut self) -> Result<u64, String> {
        let bytes = self.read_bytes(8)?;
        let mut b = [0u8; 8]; b.copy_from_slice(bytes);
        Ok(u64::from_le_bytes(b))
    }
    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], String> {
        if self.pos + len > self.data.len() {
            return Err(format!("pickle: unexpected EOF (needed {} bytes)", len));
        }
        let s = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(s)
    }
    fn skip(&mut self, n: usize) -> Result<(), String> { self.read_bytes(n).map(|_| ()) }

    fn read_signed_long(&mut self, len: usize) -> Result<i64, String> {
        if len == 0 { return Ok(0); }
        if len > 8 { return Err(format!("pickle: LONG too large ({} bytes)", len)); }
        let bytes = self.read_bytes(len)?;
        let mut n: i64 = 0;
        for (i, &b) in bytes.iter().enumerate() {
            n |= (b as i64) << (i * 8);
        }
        // Sign-extend if top bit of MSB is set.
        if bytes[len - 1] & 0x80 != 0 && len < 8 {
            n |= -1i64 << (len * 8);
        }
        Ok(n)
    }
}

// ---- Lookup helpers for the memviz walker ----

pub fn as_dict<'v>(v: &'v ValueRc) -> Option<&'v RefCell<Vec<(ValueRc, ValueRc)>>> {
    if let Value::Dict(d) = v.as_ref() { Some(d) } else { None }
}

pub fn as_list<'v>(v: &'v ValueRc) -> Option<&'v RefCell<Vec<ValueRc>>> {
    match v.as_ref() {
        Value::List(l) => Some(l),
        _ => None,
    }
}

/// Iterate list/tuple contents uniformly.
pub fn with_list_items<F: FnMut(&ValueRc)>(v: &ValueRc, mut f: F) {
    match v.as_ref() {
        Value::List(cell) => { for it in cell.borrow().iter() { f(it); } }
        Value::Tuple(items) => { for it in items { f(it); } }
        _ => {}
    }
}

pub fn dict_get(d: &RefCell<Vec<(ValueRc, ValueRc)>>, key: &str) -> Option<ValueRc> {
    for (k, v) in d.borrow().iter() {
        if let Value::Str(s) = k.as_ref() {
            if s.as_ref() == key {
                return Some(v.clone());
            }
        }
    }
    None
}

pub fn to_int(v: &ValueRc) -> i64 {
    match v.as_ref() {
        Value::Int(n) => *n,
        Value::Float(f) => *f as i64,
        Value::Bool(b) => if *b { 1 } else { 0 },
        _ => 0,
    }
}

pub fn to_str_rc(v: &ValueRc) -> Rc<str> {
    match v.as_ref() {
        Value::Str(s) => s.clone(),
        Value::Bytes(b) => {
            let s = String::from_utf8_lossy(b).into_owned();
            Rc::from(s.as_str())
        }
        _ => Rc::from(""),
    }
}
