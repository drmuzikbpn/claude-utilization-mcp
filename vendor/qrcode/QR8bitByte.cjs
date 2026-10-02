// Vendored from qrcode-terminal 0.12.0 (vendor/QRCode/QR8bitByte.js), unmodified except that
// require() paths name the .cjs files. QRCode for JavaScript: Copyright (c) 2009 Kazuhiko
// Arase, MIT licence; node port: qrcode-terminal, Apache-2.0. See ./LICENSE.
var QRMode = require('./QRMode.cjs');

function QR8bitByte(data) {
	this.mode = QRMode.MODE_8BIT_BYTE;
	this.data = data;
}

QR8bitByte.prototype = {

	getLength : function() {
		return this.data.length;
	},
	
	write : function(buffer) {
		for (var i = 0; i < this.data.length; i++) {
			// not JIS ...
			buffer.put(this.data.charCodeAt(i), 8);
		}
	}
};

module.exports = QR8bitByte;
