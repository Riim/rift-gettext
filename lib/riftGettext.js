var path = require('path');

var acorn = require('acorn');
var traverse = require('acorn/dist/walk').simple;
var gettextParser = require('gettext-parser');

var reEscapableChars = /([?+|$(){}[^.\-\]\/\\*])/g;

function escapeRegExp(str) {
	return str.replace(reEscapableChars, '\\$1');
}

function isStringLiteral(node) {
	return node.type == 'Literal' && typeof node.value == 'string';
}

function isStringConcatExpr(node) {
	var left = node.left;
	var right = node.right;

	return node.type == 'BinaryExpression' && node.operator == '+' && (
		(isStringLiteral(left) || isStringConcatExpr(left)) &&
			(isStringLiteral(right) || isStringConcatExpr(right))
	);
}

function getTranslatable(node, fnNames) {
	if (!node.arguments) {
		return null;
	}

	var callee = node.callee;
	var calleeName = callee.name;
	var firstArg = node.arguments[0];
	var secondArg = node.arguments[1];

	if (!calleeName) {
		if (callee.type != 'MemberExpression') {
			return null;
		}

		if (callee.property.name == 'call') {
			var prop = callee.object.property;

			calleeName = callee.object.name || prop && (prop.name || prop.value);

			firstArg = node.arguments[1];
			secondArg = node.arguments[2];
		} else {
			calleeName = callee.property.name;
		}
	}

	if (calleeName == fnNames[0] && firstArg && (isStringLiteral(firstArg) || isStringConcatExpr(firstArg))) {
		return [firstArg];
	}

	if (
		calleeName == fnNames[1] &&
			firstArg && (isStringLiteral(firstArg) || isStringConcatExpr(firstArg)) &&
			secondArg && (isStringLiteral(secondArg) || isStringConcatExpr(secondArg))
	) {
		return [firstArg, secondArg];
	}

	return null;
}

function extractString(node) {
	return isStringLiteral(node) ? node.value : extractString(node.left) + extractString(node.right);
}

function parse(sources, opts) {
	if (!opts) {
		opts = {};
	}

	var fnNames = opts.fnNames || ['gettext', 'ngettext'];

	var reInsert = RegExp(
		'\\{\\{(?:=(\\s*(' + fnNames[0] + '|' + fnNames[1] + ')(?:\\s+(\\S[\\s\\S]*?))??\\s*)|\\/\\/([\\s\\S]*?))\\}\\}'
	);
	var reComment = RegExp('^(?:\\/|\\s*' + escapeRegExp(opts.commentPrefix || 'L10n:') + ')\\s*(\\S[\\s\\S]*?)\\s*$');

	var pluralMsgStr = (new Array((opts.pluralFormCount || 2) + 1))
		.join('.')
		.split('')
		.map(function() { return ''; });

	var poJSON;

	if (opts.existingPO) {
		poJSON = gettextParser.po.parse(opts.existingPO);
	} else {
		poJSON = {
			charset: 'utf-8',

			headers: {
				'project-id-version': opts.projectIdVersion || 'PACKAGE VERSION',
				'report-msgid-bugs-to': opts.reportBugsTo,
				'pot-creation-date': '',
				'po-revision-date': 'YEAR-MO-DA HO:MI+ZONE',
				'language-team': 'LANGUAGE <ll@li.org>',
				'language': opts.language || '',
				'mime-version': '1.0',
				'content-type': 'text/plain; charset=utf-8',
				'content-transfer-encoding': '8bit'
			},

			translations: {
				'': {}
			}
		};
	}

	poJSON.headers['pot-creation-date'] = new Date().toISOString()
		.replace('T', ' ')
		.replace(/:\d{2}.\d{3}Z/, '+0000');

	var translations = poJSON.translations[''];

	if (opts.existingPO) {
		Object.keys(translations).forEach(function(msgid) {
			translations[msgid].comments = {
				extracted: '',
				reference: ''
			};
		});
	}

	function templateToJS(tmpl) {
		var js = [];

		tmpl = tmpl.split(reInsert);

		for (var i = 0, l = tmpl.length; i < l;) {
			if (i % 5) {
				if (tmpl[i]) {
					var params = tmpl[i + 2];

					if (params) {
						js.push(tmpl[i + 1] + '(' + params + ');');
					}

					js.push(tmpl[i].replace(/[^\r\n]+/g, '1;'));
				} else {
					js.push('/* ' + tmpl[i + 3].trim().replace(/^\//, 'L10n: ') + ' */');
				}

				i += 4;
			} else {
				js.push(tmpl[i].replace(/[^\r\n]+/g, '1;'));
				i++;
			}
		}

		return js.join('');
	}

	Object.keys(sources).forEach(function(file) {
		var source = sources[file];

		if (path.extname(file) == '.rtt') {
			source = templateToJS(source);
		}

		var comments = [];
		var ast = acorn.parse(source, {
			ecmaVersion: 6,
			sourceType: 'module',

			onComment: function(block, text, start, end, startLocation) {
				if (reComment.test(text)) {
					comments.push({
						line: startLocation.line,
						column: startLocation.column,
						value: RegExp.$1,
						used: false
					});
				}
			},

			locations: true
		});

		function findComments(line) {
			var prevCommentLine = 0;
			var foundComments = [];

			for (var i = comments.length; i;) {
				var comment = comments[--i];
				var commentLine = comment.line;

				if (
					!comment.used
						&& (commentLine == line || commentLine == line - 1 || commentLine == prevCommentLine - 1)
				) {
					foundComments.unshift(comment.value);
					comment.used = true;
					prevCommentLine = commentLine;
				} else if (prevCommentLine) {
					break;
				}
			}

			return foundComments.join('\n');
		}

		traverse(ast, {
			CallExpression: function(node) {
				var translatable = getTranslatable(node, fnNames);

				if (!translatable) {
					return;
				}

				var line = node.loc.start.line;
				var comments = findComments(line);
				var ref = file + ':' + line;
				var str = extractString(translatable[0]);

				if (translations[str]) {
					if (comments) {
						translations[str].comments.extracted += '\n' + comments;
					}

					translations[str].comments.reference += '\n' + ref;
				} else {
					translations[str] = {
						comments: {
							extracted: comments,
							reference: ref
						},

						msgid: str,
						msgstr: ''
					};

					if (translatable.length > 1) {
						translations[str].msgid_plural = extractString(translatable[1]);
						translations[str].msgstr = pluralMsgStr.slice();
					}
				}
			}
		});

		function dedupe(item, i, arr) {
			return item && arr.indexOf(item) == i;
		}

		Object.keys(translations).forEach(function(msgid) {
			var comments = translations[msgid].comments;

			if (comments.reference) {
				comments.reference = comments.reference.split('\n').filter(dedupe).join('\n');
			}
			if (comments.extracted) {
				comments.extracted = comments.extracted.split('\n').filter(dedupe).join('\n');
			}
		});
	});

	return poJSON;
}

exports.parse = parse;

function generate(sources, opts) {
	return gettextParser.po.compile(parse(sources, opts)).toString();
}

exports.generate = generate;
