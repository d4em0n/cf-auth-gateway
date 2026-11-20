import profile from '../profiles/example.json';
import {createGateway} from './engine.js';
const gateway=createGateway(profile);
export default {fetch(request,env){return gateway(request,env);}};
