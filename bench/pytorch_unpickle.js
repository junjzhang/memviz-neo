function unpickle(buffer) {
  try {
    const decoder = new TextDecoder();
    const jsonString = decoder.decode(new Uint8Array(buffer));
    const data = JSON.parse(jsonString);

    return data;
  } catch (e) {
    
  }
  return unpickleData(buffer);
}

function unpickleData(buffer) {
  const bytebuffer = new Uint8Array(buffer);
  const decoder = new TextDecoder();

  const stack = [];
  const marks = [];
  const memo = [];
  let offset = 0;
  let memo_id = 0;

  const APPENDS = 'e'.charCodeAt(0);
  const BINGET = 'h'.charCodeAt(0);
  const BININT = 'J'.charCodeAt(0);
  const BININT1 = 'K'.charCodeAt(0);
  const BININT2 = 'M'.charCodeAt(0);
  const EMPTY_DICT = '}'.charCodeAt(0);
  const EMPTY_LIST = ']'.charCodeAt(0);
  const FRAME = 0x95;
  const LONG1 = 0x8a;
  const LONG_BINGET = 'j'.charCodeAt(0);
  const MARK = '('.charCodeAt(0);
  const MEMOIZE = 0x94;
  const PROTO = 0x80;
  const SETITEMS = 'u'.charCodeAt(0);
  const SHORT_BINUNICODE = 0x8c;
  const STOP = '.'.charCodeAt(0);
  const TUPLE2 = 0x86;
  const APPEND = 'a'.charCodeAt(0);
  const NEWFALSE = 0x89;
  const BINPUT = 'q'.charCodeAt(0);
  const BINUNICODE = 'X'.charCodeAt(0);
  const EMPTY_TUPLE = ')'.charCodeAt(0);
  const NEWTRUE = 0x88;
  const NONE = 'N'.charCodeAt(0);
  const BINFLOAT = 'G'.charCodeAt(0);
  const TUPLE = 't'.charCodeAt(0);
  const TUPLE1 = 0x85;
  const TUPLE3 = 0x87;
  // untested
  const LONG_BINPUT = 'r'.charCodeAt(0);
  const LIST = 'l'.charCodeAt(0);
  const DICT = 'd'.charCodeAt(0);
  const SETITEM = 's'.charCodeAt(0);

  const scratch_buffer = new ArrayBuffer(8);
  const scratch_bytes = new Uint8Array(scratch_buffer);
  const big = new BigInt64Array(scratch_buffer);
  const float64 = new Float64Array(scratch_buffer);

  function read_uint4() {
    const n =
      bytebuffer[offset] +
      bytebuffer[offset + 1] * 256 +
      bytebuffer[offset + 2] * 65536 +
      bytebuffer[offset + 3] * 16777216;
    offset += 4;
    return n;
  }
  function setitems(d, mark) {
    for (let i = mark; i < stack.length; i += 2) {
      d[stack[i]] = stack[i + 1];
    }
    stack.splice(mark, Infinity);
  }

  while (true) {
    const opcode = bytebuffer[offset++];
    switch (opcode) {
      case PROTO:
        {
          const version = bytebuffer[offset++];
          if (version < 2 || version > 4) {
            throw new Error(`Unhandled version ${version}`);
          }
        }
        break;
      case APPEND:
        {
          const v = stack.pop();
          stack.at(-1).push(v);
        }
        break;
      case APPENDS:
        {
          const mark = marks.pop();
          const arr = stack[mark - 1];
          arr.push(...stack.splice(mark, Infinity));
        }
        break;
      case LIST:
      case TUPLE:
        {
          const mark = marks.pop();
          stack.push([...stack.splice(mark, Infinity)]);
        }
        break;
      case NEWFALSE:
        stack.push(false);
        break;
      case NEWTRUE:
        stack.push(true);
        break;
      case NONE:
        stack.push(null);
        break;
      case BINGET:
        stack.push(memo[bytebuffer[offset++]]);
        break;
      case BININT:
        {
          let i32 = read_uint4();
          if (i32 > 0x7fffffff) {
            i32 -= 0x100000000;
          }
          stack.push(i32);
        }
        break;
      case BININT1:
        stack.push(bytebuffer[offset++]);
        break;
      case BININT2:
        {
          const v = bytebuffer[offset] + bytebuffer[offset + 1] * 256;
          stack.push(v);
          offset += 2;
        }
        break;
      case EMPTY_DICT:
        stack.push({});
        break;
      case EMPTY_LIST:
        stack.push([]);
        break;
      case FRAME:
        offset += 8;
        break;
      case LONG1:
        {
          const s = bytebuffer[offset++];
          if (s <= 8) {
            for (let i = 0; i < s; i++) {
              scratch_bytes[i] = bytebuffer[offset++];
            }
            const fill = scratch_bytes[s - 1] >= 128 ? 0xff : 0x0;
            for (let i = s; i < 8; i++) {
              scratch_bytes[i] = fill;
            }
            stack.push(Number(big[0]));
          } else { // BigInt
            let scratch_bytes_unbounded = [];
            for (let i = 0; i < s; i++) {
              scratch_bytes_unbounded.push(bytebuffer[offset++]);
            }

            // BigInt can only convert from unsigned hex, thus we need to
            // convert from twos-complement if negative
            const negative = scratch_bytes_unbounded[s - 1] >= 128;
            if (negative) {
              // implements scratch_bytes_unbounded = ~scratch_bytes_unbounded + 1
              // byte-by-byte.
              let carry = 1;
              for (let i = 0; i < s; i++) {
                const twos_complement = (0xff ^ scratch_bytes_unbounded[i]) + carry;
                carry = twos_complement > 0xff ? 1 : 0;
                scratch_bytes_unbounded[i] = 0xff & twos_complement;
              }
            }

            const hex_str = Array.from(scratch_bytes_unbounded.reverse(), byte => {
              return byte.toString(16).padStart(2, '0');
            }).join('');

            const big_int = negative ? -BigInt(`0x${hex_str}`) : BigInt(`0x${hex_str}`);
            stack.push(big_int);
          }
        }
        break;
      case LONG_BINGET:
        {
          const idx = read_uint4();
          stack.push(memo[idx]);
        }
        break;
      case MARK:
        marks.push(stack.length);
        break;
      case MEMOIZE:
        memo[memo_id++] = stack.at(-1);
        break;
      case BINPUT:
        memo[bytebuffer[offset++]] = stack.at(-1);
        break;
      case LONG_BINPUT:
        memo[read_uint4()] = stack.at(-1);
        break;
      case SETITEMS:
        {
          const mark = marks.pop();
          const d = stack[mark - 1];
          setitems(d, mark);
        }
        break;
      case SETITEM: {
        const v = stack.pop();
        const k = stack.pop();
        stack.at(-1)[k] = v;
        break;
      }
      case DICT:
        {
          const mark = marks.pop();
          const d = {};
          setitems(d, mark);
          stack.push(d);
        }
        break;
      case SHORT_BINUNICODE:
        {
          const n = bytebuffer[offset++];
          stack.push(decoder.decode(new Uint8Array(buffer, offset, n)));
          offset += n;
        }
        break;
      case BINUNICODE:
        {
          const n = read_uint4();
          stack.push(decoder.decode(new Uint8Array(buffer, offset, n)));
          offset += n;
        }
        break;
      case STOP:
        return stack.pop();
      case EMPTY_TUPLE:
        stack.push([]);
        break;
      case TUPLE1:
        stack.push([stack.pop()]);
        break;
      case TUPLE2:
        stack.push(stack.splice(-2, Infinity));
        break;
      case TUPLE3:
        stack.push(stack.splice(-3, Infinity));
        break;
      case BINFLOAT:
        for (let i = 7; i >= 0; i--) {
          // stored in big-endian order
          scratch_bytes[i] = bytebuffer[offset++];
        }
        stack.push(float64[0]);
        break;
      default:
        throw new Error(`UNKNOWN OPCODE: ${opcode}`);
    }
  }
}

