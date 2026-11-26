var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/remote-api/index.ts
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
var _relay_dec, _execute_dec, _identify_dec, _diagnose_dec, _prepareRuntime_dec, _a, _init;
var PairingRemote = class extends (_a = TypertRemoteService, _prepareRuntime_dec = [Remote], _diagnose_dec = [Remote], _identify_dec = [Remote], _execute_dec = [Remote], _relay_dec = [Remote], _a) {
  constructor(ctx) {
    super(ctx, "stackchanPairingRemote", { namespace: "stackchanPairing" });
    __runInitializers(_init, 5, this);
  }
  async prepareRuntime(signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may prepare StackChan runtime.", {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.prepareRuntime(signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError("stackchan/pairing-failed", "StackChan runtime setup needs attention.", { reason: result.error });
    return result.value;
  }
  async diagnose(signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may manage StackChan pairing.", {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.diagnose(signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError("stackchan/pairing-failed", "StackChan environment check needs attention.", { reason: result.error });
    return result.value;
  }
  async identify(port, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may identify a StackChan device.", {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.identify(port, signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError("stackchan/pairing-failed", "StackChan identification needs attention.", { reason: result.error });
    return result.value;
  }
  async execute(request, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may manage StackChan pairing.", {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.call(request, signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError("stackchan/pairing-failed", "StackChan pairing needs attention.", { reason: result.error });
    return result.value;
  }
  async relay(request, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may configure the StackChan relay.", {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.relay(request, signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError("stackchan/pairing-failed", "StackChan relay setup needs attention.", { reason: result.error });
    return result.value;
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "prepareRuntime", _prepareRuntime_dec, PairingRemote);
__decorateElement(_init, 1, "diagnose", _diagnose_dec, PairingRemote);
__decorateElement(_init, 1, "identify", _identify_dec, PairingRemote);
__decorateElement(_init, 1, "execute", _execute_dec, PairingRemote);
__decorateElement(_init, 1, "relay", _relay_dec, PairingRemote);
__decoratorMetadata(_init, PairingRemote);
var _execute_dec2, _preview_dec, _environment_dec, _a2, _init2;
var VoiceRemote = class extends (_a2 = TypertRemoteService, _environment_dec = [Remote], _preview_dec = [Remote], _execute_dec2 = [Remote], _a2) {
  constructor(ctx) {
    super(ctx, "stackchanVoiceRemote", { namespace: "stackchanVoice" });
    __runInitializers(_init2, 5, this);
  }
  async environment(action, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may check StackChan voice.", {});
    signal.throwIfAborted();
    try {
      return await this.ctx.stackchanVoice.environment(action, signal);
    } catch (error) {
      const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "voice_environment_failed";
      throw new RemoteError("stackchan/voice-failed", "StackChan voice environment needs attention.", { reason });
    }
  }
  async preview(language, voice, speechRate, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may preview StackChan voice.", {});
    signal.throwIfAborted();
    try {
      return await this.ctx.stackchanVoice.preview({ language, voice, speechRate }, signal);
    } catch (error) {
      const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "voice_preview_failed";
      throw new RemoteError("stackchan/voice-failed", "StackChan voice preview needs attention.", { reason });
    }
  }
  async execute(action, signal) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner")
      throw new RemoteError("stackchan/owner-required", "Only the owner may control StackChan voice.", {});
    signal.throwIfAborted();
    try {
      return await this.ctx.stackchanVoice.execute(action, signal);
    } catch (error) {
      const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "voice_connect_failed";
      throw new RemoteError("stackchan/voice-failed", "StackChan voice needs attention.", { reason });
    }
  }
};
_init2 = __decoratorStart(_a2);
__decorateElement(_init2, 1, "environment", _environment_dec, VoiceRemote);
__decorateElement(_init2, 1, "preview", _preview_dec, VoiceRemote);
__decorateElement(_init2, 1, "execute", _execute_dec2, VoiceRemote);
__decoratorMetadata(_init2, VoiceRemote);
export {
  PairingRemote,
  VoiceRemote
};
