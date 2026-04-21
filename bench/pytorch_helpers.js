function version_space() {
  const version = {};
  return (addr, increment) => {
    if (!(addr in version)) {
      version[addr] = 0;
    }
    const r = version[addr];
    if (increment) {
      version[addr]++;
    }
    return r;
  };
}

function Segment(addr, size, stream, frames, version, user_metadata, segment_pool_id) {
  return {addr, size, stream, version, frames, user_metadata, segment_pool_id};
}

function Block(addr, size, requested_size, frames, free_requested, version, user_metadata) {
  return {addr, size, requested_size, frames, free_requested, version, user_metadata};
}

