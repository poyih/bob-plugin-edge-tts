// Sec-MS-GEC v2 的 CS64 校验，输入为协议规定的 ASCII 字串及其 SHA-256 hex。
// 只实现协议运算：32 位小端字、模 2^32 乘法、16 位循环移位；不依赖 BigInt 或原生 crypto。
// 协议参考：https://github.com/rany2/edge-tts/pull/492

function swap16(value) {
    return (value << 16) | (value >>> 16);
}

function littleWord(text, offset) {
    var word = 0;
    for (var i = 0; i < 4 && offset + i < text.length; i++) {
        word |= text.charCodeAt(offset + i) << (i * 8);
    }
    return word;
}

function digestWord(hex, offset) {
    var word = 0;
    for (var i = 0; i < 4; i++) {
        word |= parseInt(hex.substr(offset + i * 2, 2), 16) << (i * 8);
    }
    return word | 1;
}

function littleHex(word) {
    var hex = "";
    for (var i = 0; i < 4; i++) {
        hex += ("0" + ((word >>> (i * 8)) & 0xff).toString(16)).slice(-2);
    }
    return hex.toUpperCase();
}

function cs64Hex(message, sha256Hex) {
    var a = digestWord(sha256Hex, 0);
    var b = digestWord(sha256Hex, 8);
    var swappedLast = 0;
    var swappedSum = 0;
    var chained = 0;
    var chainedSum = 0;
    var chainFactors = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83];

    // 每次读两个小端字；不足 8 字节的尾部补零。
    for (var offset = 0; offset < message.length; offset += 8) {
        var x = littleWord(message, offset);
        var y = littleWord(message, offset + 4);
        var left = swap16((Math.imul(swap16(x), 0xef0569fb) + Math.imul(x, a)) | 0);
        var right = swap16((Math.imul(swap16(y), 0xc31713db) + Math.imul(y, b)) | 0);
        left = Math.imul(left, 0x76f50f34);
        right = Math.imul(right, 0x1881ce3c);
        swappedLast = (Math.imul(swap16(right), 0x35bd1ec9) + right) | 0;
        swappedSum = (swappedSum + Math.imul(swap16(left), 0xc3efea97) + left + swappedLast) | 0;

        chained = Math.imul((chained + x) | 0, a);
        for (var i = 0; i < chainFactors.length; i++) {
            chained = Math.imul(swap16(chained), chainFactors[i]);
        }
        chainedSum = (chainedSum + chained) | 0;
        var next = Math.imul((chained + y) | 0, b);
        next = Math.imul(swap16(next), 0xa27416f5);
        next = Math.imul(swap16(next), 0xd38396ff);
        next = Math.imul(swap16(next), 0x7c932b89);
        chained = Math.imul(swap16(next), 0xbfa49f69);
        chainedSum = (chainedSum + chained) | 0;
    }
    return littleHex(swappedLast ^ chained) + littleHex(swappedSum ^ chainedSum);
}

exports.cs64Hex = cs64Hex;
