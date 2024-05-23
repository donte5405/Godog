//@ts-check
import { join } from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { getConfig } from "./options.mjs";
import { loadGodotLabels } from "./godot.labels.mjs";
import { labels } from "./labels.mjs";
import { crucialPreprocessorBlocks } from "./preprocessor.mjs";
import { hasTranslations, parseTranslations } from "./locale.mjs";
import {
    asciiNumbers,
    asciiSymbols,
    isLabel,
    isString,
    jsonStringParse,
    jsonStringStringify,
    looksLikeNodePath,
    looksLikeProtocolPath,
    getProtocolAndPath, 
    checkFileExtension,
    processNodePath,
} from "./strings.mjs";
import { assemble, tokenise } from "./token.mjs";
// import { writeFileSync } from "fs";
// import { randomUUID } from "crypto";
// import { fileURLToPath } from "url";
// import { dirname, join } from "path";


// const __filename = fileURLToPath(import.meta.url);
// const testPath = join(dirname(__filename), "../", "../", "/TEST");


/** @param {string} fileName */
const directFormatStringProhibitedErr = (fileName) => `[${fileName}]\n\nDirect string path formatting (%) isn't allowed. If the string isn't a string path, try to workaround by either adding spaces to the string if possible, or using 'str(...)' to format strings instead. Noting that it'll never work if you're trying to workaround file path string formattings, that will only make it worse or outright corrupting the entire project.\n\nUnless you absolutely know what you're doing, disable this option with 'ignoreStringFormattings'.\n\nRead docs for more info.\n\n`;


/** @type {string[]} User-defined GDScript types. */
const gdScriptUserTypes = [];


/** @type {string[]} List of banned labels. Will load default ones from Godot internal labels. */
const bannedLabels = await loadGodotLabels();


/** List of banned labels that are generated by the user. */
const myBannedLabels = [];


/**
 * Find current line amount of indents.
 * @param {string[]} tokens 
 * @param {number} i 
 */
function countIndents(tokens, i) {
    let count = 0;
    for (i -= 1; i >= 0; i--) {
        if (tokens[i] === "\n") break;
        if (tokens[i] !== "\t") continue;
        count++;
    }
    return count;
}


/**
 * If specified token has Indentation at its front.
 * @param {string[]} tokens 
 * @param {number} i 
 */
function hasIndentAtItsFront(tokens, i) {
    return [ "\t", "\n" ].includes(tokens[i - 1]);
}


/**
 * @param {string} token
 * @param {string[]} tokens 
 * @param {number} i 
 */
function removeTypeCasting(token, tokens, i) {
    // If type casting shouldn't be bothered, skip.
    if (!getConfig().removeTypeCasting) return token;
    if (tokens[i - 1] === ":" && [ "=", ",", ")", "\n" ].includes(tokens[i + 1])) {
        let bracesStack = 0;
        for (let ii = i - 4; ii > 0; ii--) {
            // Export types without manual inferring still need type casting.
            if (tokens[ii] === ")") bracesStack ++;
            if (tokens[ii] === "(") bracesStack --;
            if (bracesStack) continue;
            if (tokens[ii] === "export") return token; // Prevent catastrophe where Godot needs type to stay in export types.
            if (tokens[ii] === "\n") break;
        }
        // Remove explicit type casting.
        tokens[i - 1] = "";
        return "";
    }
    if (tokens[i - 2] === ")" && tokens[i - 1] === "->" && tokens[i + 1] === ":") {
        // Remove arrow token (return type).
        tokens[i - 1] = "";
        return "";
    }
    if (tokens[i - 1] === "as") {
        // Remove "as" casting.
        tokens[i - 1] = "";
        return "";
    }
    // Ignore godot labels.
    return token;
}


/** Token parser object. */
export class GDParser {
    /** For detecting local vars in the scoped (inner) class indentation. */
    currentClassIndent = 0;
    /** @type {Record<string,string>} Explicitly defined user labels. */
    userPrivateLabels = {};
    /** @type {Record<string,string>} Private labels. */
    privateLabels = {};
    /** Filename that the parser is handling. Does nothing except warning users. */
    fileName = "";
    /** If this parser is still in ignore block. */
    isInIgnoreBlock = false;

    /**
     * Construct a token parser.
     * @param {"gd"|"clang"|"tscn"|"path"} mode
     */
    constructor(mode = "gd") {
        this.mode = mode;
    }

    /**
     * Parse a file and get the result immediately.
     * @param {string} fileName
     * @param {"gd"|"clang"|"tscn"|"path"} mode
     */
    static async parseFile(fileName, mode = "gd") {
        return new this(mode).tellFileName(fileName).parse(await readFile(fileName, { encoding: "utf-8" }), mode);
    }

    /**
     * Parse a string and get the result immediately.
     * @param {string} str 
     * @param {"gd"|"clang"|"tscn"|"path"} mode
     */
    static parseStr(str, mode = "gd") {
        const o = new this(mode);
        // const uuid = randomUUID();
        // const a = o.tokenise(str);
        // writeFileSync(testPath + "/" + uuid + ".a.json", JSON.stringify(a) );
        // const b = o.parseTokens(a);
        // writeFileSync(testPath + "/" + uuid + ".b.json", JSON.stringify(b) );
        // const c = o.assemble(b);
        // writeFileSync(testPath + "/" + uuid + ".c.tscn", c );
        // return c;
        // return o.assemble(o.parseTokens(a));
        return o.parse(str, mode);
    }

    /**
     * Tell file name that this parser is handling.
     * @param {string} name 
     */
    tellFileName(name) {
        this.fileName = name;
        return this;
    }

    /**
     * Do a complete parsing procedure in one shot.
     * @param {string} str 
     */
    parse(str, mode = this.mode) {
        return this.assemble(this.parseTokens(this.tokenise(str, mode), mode), mode);
    }

    /**
     * Tokenise GDScript into something able to be processed.
     * @param {string} str 
     */
    tokenise(str, mode = this.mode) {
        return tokenise(str, mode);
    }

    /**
     * Parse the token and process it.
     * @param {string[]} tokens 
     */
    parseTokens(tokens, mode = this.mode) {
        for (let i = 0; i < tokens.length; i++) {
            tokens[i] = this.parseToken(tokens, i, mode);
        }
        return tokens;
    }

    /**
     * Get a private label mapped to the specified source label.
     * @param {string} sourceLabel 
     */
    _getOrAddPrivateLabel(sourceLabel, fromUser = false) {
        if (!this.privateLabels[sourceLabel]) {
            this.privateLabels[sourceLabel] = labels.get();
            if (fromUser) {
                this.userPrivateLabels[sourceLabel] = this.privateLabels[sourceLabel];
            }
        }
        return this.privateLabels[sourceLabel];
    }

    /**
     * Parse specified token and decide if the specified token should be returned as what.
     * @param {string|string[]} tokens
     * @param {number} i
     * @param {"gd"|"clang"|"tscn"|"path"} mode
     * @returns {string}
     */
    parseToken(tokens, i = 0, mode = this.mode) {
        if (typeof tokens === "string") {
            tokens = [tokens];
        }

        const token = tokens[i];

        // Ignore empty lines.
        if (!token) return "";

        // Get config.
        const config = getConfig();

        // Process symbols.
        if (asciiSymbols.includes(token[0])) {
            // For GDScript only.
            if (mode === "gd") {
                // Parse comment.
                if (token[0] === "#") {
                    const tokenNsp = token.split(" ").join("");
                    for (const block of crucialPreprocessorBlocks) {
                        if (tokenNsp.indexOf(block) === 0) {
                            config.crucialPreprocessorsDetected = true;
                            // Keep the comment for now, will use platform-specific preprocessors.
                            return token;
                        }
                    }
                    if (tokenNsp.indexOf("#GODOG_EXPOSE:") === 0) {
                        // Ban a label to make it readable in the final release.
                        const newBannedLabels = tokenNsp.split("#GODOG_EXPOSE:")[1].split(",");
                        for (const label of newBannedLabels) {
                            myBannedLabels.push(label);
                            bannedLabels.push(label);
                        }
                        return token;
                    }
                    if (tokenNsp.indexOf("#GODOG_IGNORE") === 0) {
                        // Ignore code blocks that aren't required.
                        this.isInIgnoreBlock = !this.isInIgnoreBlock;
                        return "";
                    }
                    if (tokenNsp.indexOf("#GODOG_LABEL:") === 0) {
                        // Define scrambled label.
                        const userLabels = tokenNsp.split("#GODOG_LABEL:")[1].split(",");
                        for (const userLabel of userLabels) {
                            labels.get(userLabel);
                        }
                        // Remove comment.
                        return "";
                    }
                    if (tokenNsp.indexOf("#GODOG_PRIVATE:") === 0) {
                        // Define private labels.
                        const privateLabels = tokenNsp.split("#GODOG_PRIVATE:")[1].split(",");
                        for (const privateLabel of privateLabels) {
                            this._getOrAddPrivateLabel(privateLabel, true);
                        }
                        // Remove comment.
                        return "";
                    }
                    // Remove comment.
                    return "";
                }
                if (this.isInIgnoreBlock) {
                    // Remove everything inside the ignore block (for symbols).
                    return "";
                }
                // Remove inferred type casting.
                if (token === ":=") {
                    if (config.removeTypeCasting) {
                        return "=";
                    }
                    return token;
                }
            }

            // Parse user-defined strings.
            if (isString(token)) {
                if (mode === "gd") {
                    // TODO: support string formatting if possible.
                    if (tokens[i + 1] === "." && tokens[i + 2] === "format" && tokens[i + 3] === "(") {
                        throw new Error("It looks like you're trying to use placeholder-based string formatting with " + token + ". It's not supported by GODOG yet.");
                    }
                    // Avoid RegEx possibilities.
                    if (tokens[i - 3] === "." && tokens[i - 2] === "compile" && tokens[i - 1] === "(") {
                        return token;
                    }
                    if (tokens[i - 3] === "." && tokens[i - 2] === "search" && tokens[i - 1] === "(") {
                        return token;
                    }
                    if (tokens[i - 3] === "." && tokens[i - 2] === "search_all" && tokens[i - 1] === "(") {
                        return token;
                    }
                    if (tokens[i - 5] === "." && tokens[i - 4] === "sub" && tokens[i - 3] === "(" && isString(tokens[i - 1]) && tokens[i - 2] === ",") {
                        return token;
                    }
                } else if (mode === "tscn") {
                    if (tokens[i - 8] === "application" && tokens[i - 4] === "config" && tokens[i - 3] === "/" && tokens[i - 2] === "name" && tokens[i - 1] === "=") {
                        return token; // Prevent game name to be changed (crucial, because Godot references this for file saving).
                    }
                }
                let str = jsonStringParse(token, mode === "tscn");
                if (hasTranslations(str)) {
                    // If it has translation strings.
                    str = parseTranslations(str);
                } else if (looksLikeProtocolPath(str)) {
                    // If it looks like protocol path, ignore most of them.
                    const [ pathProtocol, path ] = getProtocolAndPath(str);
                    if (pathProtocol === "res") {
                        if (!getConfig().meltEnabled) return token;
                        const filePath = join(getConfig().projDirPath, path);
                        if (checkFileExtension(filePath, [ "tscn", "tres", "gd" ])) {
                            if (filePath.indexOf("%") >= 0) {
                                throw new Error("Illegal file path declaration: " + filePath + ". GODOG doesn't allow dynamic remapping in scramble mode.");
                            }
                            if (!existsSync(filePath)) {
                                // Make manual formatting impossible in melt mode.
                                throw new Error("Project resource file not found: " + filePath + ".");
                            }
                        }
                    }
                    return token;
                } else if (looksLikeNodePath(str)) {
                    // If it looks like node path.
                    str = processNodePath(str, (section) => this.parse(section, "path"));
                }
                return jsonStringStringify(str, mode === "tscn");
            }

            // Other symbols.
            return token;
        }
        if (this.isInIgnoreBlock) {
            // Remove everything inside the ignore block (for labels).
            return "";
        }
        if (asciiNumbers.includes(token[0])) {
            // Ignore labels starting with numbers.
            return token;
        }
        if (mode === "path") { // For path strings.
            // Ignore banned (Godot) labels.
            if (bannedLabels.includes(token)) return token;
            return labels.get(token);
        }
        if (mode === "tscn") { // For TSCN, TRES, other Godot related files, and files that don't need user labels randomisation.
            // Ignore banned (Godot) labels.
            if (bannedLabels.includes(token)) return token;
            // Only replace known strings.
            if (labels.has(token)) return labels.get(token);
            // Ignore unknown strings.
            return token;
        }
        if (mode === "gd") { // For GDScript files.
            if (isLabel(token) && tokens[i - 1] === "@") {
                // In case of Godot 4, ignore labels with potential of being annotations.
                // It should be safe to assume because Godot 3 only uses "@" for string names.
                return token;
            }
            if (bannedLabels.includes(token)) {
                if (myBannedLabels.includes(token)) return token; // Ignore user banned labels, save cycles.
                if (token === "class") {
                    // Set current (inner) class indentation depth.
                    for (i++; i < tokens.length; i++) {
                        // Find a new line.
                        if (tokens[i] === "\n") break;
                    }
                    for (i++; i < tokens.length; i++) {
                        // Find the entry of the first token behind indents.
                        if (tokens[i] !== "\t") break;
                    }
                    this.currentClassIndent = countIndents(tokens, i);
                    return token;
                } else if ([ "extends", "tool", "class_name", "var", "const", "enum", "signal", "export", "onready", "func", "static", "remote", "master", "puppet", "remotesync", "mastersync", "puppetsync" ].includes(token)) {
                    // Calibrate current (inner) class indentation if it falls into lower indentation.
                    if (hasIndentAtItsFront(tokens, i)) {// In case of Godot 4, because it has lambda.
                        const myIndent = countIndents(tokens, i);
                        if (myIndent < this.currentClassIndent) {
                            this.currentClassIndent = myIndent;
                        }
                    }
                }
                if (token === "class_name") {
                    // Note User types.
                    const className = tokens[i + 1];
                    if (!gdScriptUserTypes.includes(className)) {
                        gdScriptUserTypes.push(className);
                    }
                    return token;
                }
                if (token === "func") {
                    // Note private labels from functions.
                    let bracketStack = 1;
                    for (i++; i < tokens.length; i++) {
                        if (tokens[i] === "(") break;
                    }
                    for (i++; i < tokens.length; i++) {
                        const bToken = tokens[i];
                        if (bToken === "(") {
                            bracketStack ++;
                            continue;
                        }
                        if (bToken === ")") {
                            bracketStack --;
                            if (!bracketStack) break;
                            continue;
                        }
                        if ([",", "("].includes(tokens[i - 1])) {
                            this._getOrAddPrivateLabel(tokens[i]);
                        }
                    }
                    return token;
                }
                if (token === "var") {
                    // Note private labels created by local `var` constructors.
                    if (this.currentClassIndent === countIndents(tokens, i)) return token;
                    this._getOrAddPrivateLabel(tokens[i + 1]);
                    return token;
                }
                // Try to get rid of type casting if possible.
                return removeTypeCasting(token, tokens, i);
            }
            if (this.privateLabels[token]) {
                // Replace private token with new token.
                if ([ "extends", "class_name", "const", "enum", "signal", "func" ].includes(tokens[i - 1])) {
                    // Don't use private labels with target types that aren't explicitly defined by the user.
                    if (!this.userPrivateLabels[token] )return labels.get(token);
                }
                if (tokens[i - 1] === ".") {
                    // Don't use private labels with an accessor.
                    return labels.get(token);
                }
                return this.privateLabels[token];
            }
            if (gdScriptUserTypes.includes(token)) {
                // Remove user type casting.
                return removeTypeCasting(labels.get(token), tokens, i);
            }
            return labels.get(token);
        }
        return token;
    }

    /**
     * Assemble GD Tokens into string.
     * @param {string[]} token 
     */
    assemble(token, mode = this.mode) {
        if (this.isInIgnoreBlock) {
            throw new Error(`Incomplete '#GODOG_IGNORE' block in the file '${this.fileName}'!`);
        }
        return assemble(token, mode);
    }
}
