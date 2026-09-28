// 朗读文本的处理：清理控制字符、XML 转义、按 UTF-8 字节数在标点处分段。

var config = require("./config.js");

// 服务端遇到这些控制字符会报错（OCR 出来的 PDF 里常见垂直制表符），统一换成空格。
// 落单的代理项和 U+FFFE / U+FFFF 不是合法的 XML 字符，同样处理。
function cleanText(text) {
    var str = String(text === undefined || text === null ? "" : text)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, " ");
    if (!/[\ud800-\udfff]/.test(str)) {
        return str;
    }
    var out = "";
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                out += str.charAt(i) + str.charAt(i + 1);
                i += 1;
            } else {
                out += " ";
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            out += " ";
        } else {
            out += str.charAt(i);
        }
    }
    return out;
}

function escapeXml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 句末标点：中日文句号叹号问号、分号、省略号、印地语 danda、阿拉伯语问号与句号
var SENTENCE_END = "。！？；…।؟۔";
// 句中停顿：中日文逗号顿号冒号、阿拉伯语逗号与分号
var CLAUSE_BREAK = "，、：،؛";
// 半角标点只有后面跟着空白（或正好在文本末尾）才算断句点，免得把 3.14、1,000 切开
var ASCII_SENTENCE_END = ".!?;";
var ASCII_CLAUSE_BREAK = ",:";
// 紧跟在句末标点后面的引号和括号留在前一段
var CLOSERS = "”’」』）】》〉\"')]}";

function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "　" || ch === " ";
}

// text[index] 是分号时，判断它是不是 &amp; 这类实体的结尾
function endsEntity(text, index) {
    for (var i = index - 1; i >= 0 && index - i <= 6; i--) {
        var ch = text.charAt(i);
        if (ch === "&") {
            return i < index - 1;
        }
        if (!/[A-Za-z0-9#]/.test(ch)) {
            return false;
        }
    }
    return false;
}

// 硬切（窗口里找不到标点和空白）时，切点不能落在 &amp; 这类实体中间
function avoidEntitySplit(text, start, cut) {
    for (var i = cut - 1; i >= start && cut - i <= 6; i--) {
        var ch = text.charAt(i);
        if (ch === ";") {
            return cut;
        }
        if (ch === "&") {
            return i;
        }
    }
    return cut;
}

// 从 start 起最多能放进 maxBytes 字节的位置（不含），按码点前进，不会切开代理对
function windowEnd(text, start, maxBytes) {
    var bytes = 0;
    var i = start;
    while (i < text.length) {
        var code = text.charCodeAt(i);
        var size = 3;
        var units = 1;
        if (code < 0x80) {
            size = 1;
        } else if (code < 0x800) {
            size = 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
            text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
            size = 4;
            units = 2;
        }
        if (bytes + size > maxBytes) {
            break;
        }
        bytes += size;
        i += units;
    }
    return i;
}

// 在 [start, end) 里找最合适的切点，返回切点下标（切点之前的内容归前一段）。
// 切点分三档：换行 > 句末标点 > 逗号 / 空白。先在窗口后半段找最高的一档，找不到再看前半段，
// 都没有就硬切。换行排在句末标点前面，是为了避免「1. 第一项\n2. 第二项」在编号的句点后
// 被切开，把下一项的编号读到上一段末尾。
function findCut(text, start, end) {
    var half = start + Math.floor((end - start) / 2);
    var line = -1;
    var strong = -1;
    var weak = -1;

    for (var i = start; i < end; i++) {
        var ch = text.charAt(i);
        if (ch === "\n") {
            line = i + 1;
            continue;
        }
        var next = i + 1 < text.length ? text.charAt(i + 1) : "";
        var followedBySpace = next === "" || isWhitespace(next);
        var isStrong = false;
        var isWeak = false;

        if (SENTENCE_END.indexOf(ch) !== -1) {
            isStrong = true;
        } else if (ASCII_SENTENCE_END.indexOf(ch) !== -1) {
            isStrong = followedBySpace && !(ch === ";" && endsEntity(text, i));
        } else if (CLAUSE_BREAK.indexOf(ch) !== -1 || isWhitespace(ch)) {
            isWeak = true;
        } else if (ASCII_CLAUSE_BREAK.indexOf(ch) !== -1) {
            isWeak = followedBySpace;
        }

        if (isStrong) {
            var after = i + 1;
            while (after < end && CLOSERS.indexOf(text.charAt(after)) !== -1) {
                after += 1;
            }
            strong = after;
        } else if (isWeak) {
            weak = i + 1;
        }
    }

    var candidates = [line, strong, weak];
    var k;
    for (k = 0; k < candidates.length; k++) {
        if (candidates[k] > half) {
            return candidates[k];
        }
    }
    for (k = 0; k < candidates.length; k++) {
        if (candidates[k] > start) {
            return candidates[k];
        }
    }
    return -1;
}

// 把（已转义的）文本切成若干段，每段 UTF-8 字节数不超过 maxBytes。
// 不会切开多字节字符，也不会切开 XML 实体。
function splitText(text, maxBytes) {
    var limit = Math.max(16, Math.floor(Number(maxBytes) || config.MAX_SEGMENT_BYTES));
    var source = String(text);
    var segments = [];
    var start = 0;

    while (start < source.length) {
        var end = windowEnd(source, start, limit);
        var cut;
        if (end >= source.length) {
            cut = source.length;
        } else {
            cut = findCut(source, start, end);
            if (cut <= start) {
                cut = avoidEntitySplit(source, start, end);
            }
            if (cut <= start) {
                cut = end > start ? end : start + 1;
            }
        }
        var piece = source.slice(start, cut).trim();
        if (piece) {
            segments.push(piece);
        }
        start = cut;
    }
    return segments;
}

// 清理控制字符 -> XML 转义 -> 分段。必须先转义再分段：字节上限针对的是实际发出去的内容。
function prepareSegments(text) {
    return splitText(escapeXml(cleanText(text)), config.MAX_SEGMENT_BYTES);
}

exports.cleanText = cleanText;
exports.escapeXml = escapeXml;
exports.splitText = splitText;
exports.prepareSegments = prepareSegments;
