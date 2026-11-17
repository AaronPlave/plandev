/* A wrapper for Handlebars, so that `sequencing-server` isn't polluted with helper registration and the like. */
import Handlebars from "handlebars";
import { addTime, subtractTime, formatTime } from "./time.js";
import { rustBool, rustDurationMicros, rustEpochMicros, rustFloat, rustIdent, rustInteger, rustString } from "./rust.js";
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
Handlebars.registerHelper("rust-string", v => new Handlebars.SafeString(rustString(v)))
Handlebars.registerHelper("rust-int", v => new Handlebars.SafeString(rustInteger(v)))
Handlebars.registerHelper("rust-float", v => new Handlebars.SafeString(rustFloat(v)))
Handlebars.registerHelper("rust-bool", v => new Handlebars.SafeString(rustBool(v)))
Handlebars.registerHelper("rust-ident", v => new Handlebars.SafeString(rustIdent(v)))
Handlebars.registerHelper("rust-epoch-us", t => new Handlebars.SafeString(rustEpochMicros(t)))
Handlebars.registerHelper("rust-duration-us", d => new Handlebars.SafeString(rustDurationMicros(d)))


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
