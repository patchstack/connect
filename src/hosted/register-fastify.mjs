import { installFastifyHook } from './fastify-hook.mjs';
import { protection } from '@patchstack/connect/register';

installFastifyHook(protection);
