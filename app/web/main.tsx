import { AppRegistry, type RootTag } from 'react-native';
import App from '../App';
import { installApiAuth } from './api-auth';

// When the dev server has SAMMY_API_TOKEN set, mutating /api requests
// need a bearer token. This installs a global fetch wrapper that
// attaches it (from localStorage 'sammy.apiToken') — a no-op when no
// token is stored, which is the default for local dev.
installApiAuth();

AppRegistry.registerComponent('SammyPack', () => App);
AppRegistry.runApplication('SammyPack', {
  // react-native-web mounts into a DOM element; React Native's own types
  // only know the native numeric root tag.
  initialProps: {},
  rootTag: document.getElementById('root') as unknown as RootTag,
});
