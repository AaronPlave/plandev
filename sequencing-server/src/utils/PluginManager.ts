import path from 'path';
import { getEnv } from '../env.js';

/** Always loaded alongside the configured parser, so F Prime JSON can be uploaded to any deployment. */
export const FPRIME_DICTIONARY_PARSER_PLUGIN = '/fprime-dictionary-parser/fprime-parser.js';

/** F Prime JSON dictionaries carry `metadata.dictionarySpecVersion`; AMPCS dictionaries are XML. */
export function isFprimeDictionary(dictionary: string): boolean {
  if (!dictionary.trimStart().startsWith('{')) return false;
  try {
    return JSON.parse(dictionary)?.metadata?.dictionarySpecVersion !== undefined;
  } catch {
    return false;
  }
}

export class PluginManager {
  private DIRECTORY = "/app/plugins/";
  private plugins: Map<string, any> = new Map();
  async loadPlugins() {
    for (const name of new Set([getEnv().DICTIONARY_PARSER_PLUGIN, FPRIME_DICTIONARY_PARSER_PLUGIN])) {
      await this.loadPlugin(name);
    }
  }

  private async loadPlugin(name: string) {
      const filePath = path.join(this.DIRECTORY, name);
      try {
        const pluginModule = await import(filePath);
        const plugin = pluginModule.default;
        if (!plugin || !plugin.name || !('parseDictionary' in plugin)) {
          if (!('parseDictionary' in plugin)){
            console.error(`Invalid plugin format: ${plugin.name} at ${filePath}: Missing 'parseDictionary(commandDictionary : string)' function`);
          }else {
            console.error(`Invalid plugin format: ${plugin.name} at ${filePath}`);
          }
        }else{
          console.log(`Loaded plugin: ${plugin.name} from ${filePath}`);
          this.plugins.set(name, plugin);
        }
      } catch (error) {
        console.error(`Error loading plugin: ${filePath}`, error);
      }
  }

  getPlugin(name: string) : any | undefined {
    return this.plugins.get(name);
  }

  hasPlugin(name: string) : boolean {
    return this.plugins.has(name);
  }
}
