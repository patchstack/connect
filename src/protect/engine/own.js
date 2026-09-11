export function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return value;
}

export function appendOwn(target, key, value) {
  if (!Object.hasOwn(target, key)) return setOwn(target, key, value);
  const previous = target[key];
  return setOwn(target, key, Array.isArray(previous) ? [...previous, value] : [previous, value]);
}
