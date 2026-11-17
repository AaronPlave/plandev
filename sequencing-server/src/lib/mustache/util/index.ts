/* A wrapper for Handlebars, so that `sequencing-server` isn't polluted with helper registration and the like. */
import Handlebars from "handlebars";
import { addTime, subtractTime, formatTime } from "./time.js";
import { rustArray, rustBool, rustDurationMicros, rustEpochMicros, rustFloat, rustIdent, rustInteger, rustString } from "./rust.js";
import { getEnv } from "../../../env.js";
import { SequencingLanguage } from "../enums/language.js";

// initialized to environment variable, but this can be changed at runtime.
const environment = {
    language: getEnv().SEQUENCING_LANGUAGE
}

// helper to flatten out array
function flatten(array: any[]): string {
    if (environment.language === SequencingLanguage.STOL || environment.language === SequencingLanguage.TEXT) {
        return new Handlebars.SafeString(`[${array.join(", ")}]`).toString();
    }
    else {
        return new Handlebars.SafeString(`[${array.join(" ")}]`).toString();
    }
}

/////////////// AERIE HELPER REGISTRATION ///////////////
Handlebars.registerHelper("add-time", (t, d) => addTime(t, d, environment.language))
Handlebars.registerHelper("subtract-time", (t, d) => subtractTime(t, d, environment.language))
Handlebars.registerHelper("flatten", flatten)
Handlebars.registerHelper("format-as-date", t => formatTime(t, environment.language))
// F Prime Rust literals (see rust.ts). SafeString: the value is already a validated literal.
// Positional arguments after the value (`{{rust-int v "u8"}}`); Handlebars passes `options` last.
const rustHelper = (render: (...args: any[]) => string) => (...args: any[]) => {
  const options = args.pop()
  return new Handlebars.SafeString(render(...args, options))
}
Handlebars.registerHelper("rust-string", rustHelper(v => rustString(v)))
Handlebars.registerHelper("rust-int", rustHelper((v, type) => rustInteger(v, typeof type === "string" ? type : undefined)))
Handlebars.registerHelper("rust-float", rustHelper((v, type) => rustFloat(v, typeof type === "string" ? type : undefined)))
Handlebars.registerHelper("rust-bool", rustHelper(v => rustBool(v)))
Handlebars.registerHelper("rust-ident", rustHelper(v => rustIdent(v)))
Handlebars.registerHelper("rust-array", rustHelper((v, kind, type) => rustArray(v, kind, typeof type === "string" ? type : undefined)))
Handlebars.registerHelper("rust-epoch-us", rustHelper((t, options) => rustEpochMicros(t, options.hash.epoch)))
Handlebars.registerHelper("rust-duration-us", rustHelper(d => rustDurationMicros(d)))


/////////////// EXPOSE TO SEQUENCING-SERVER ///////////////
export class Mustache {
    private template: HandlebarsTemplateDelegate<any>

    constructor(template: string, language?: SequencingLanguage) {
        environment.language = language ?? environment.language
        this.template = Handlebars.compile(template)
    }

    public execute(data: any) {
        return this.template(data)
    }

    public setLanguage(language: SequencingLanguage) {
        environment.language = language
    }

    public getLanguage(): SequencingLanguage {
        return environment.language
    }
}
