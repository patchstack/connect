import { guardedFactory } from './fastify-hook.mjs';

export { guardedFactory as fastify, guardedFactory as default, guardedFactory as 'module.exports' };
export const { errorCodes, LogController } = guardedFactory;
