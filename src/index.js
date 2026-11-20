import profile from '../profiles/example.json';
import { createGateway } from './gateway.js';

const handleRequest = createGateway(profile);

export default {
  fetch(request, environment) {
    return handleRequest(request, environment);
  },
};
