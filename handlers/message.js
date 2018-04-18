const {getClassComment, getClassNamespace} = require('./base')
const config = require('../config')
const baseNamespace = config.get('baseNamespace')
const typeMap = require('../types')

const genTypeClass = (messageType, s, proto) => {
  const properties = []
  const classNamespace = getClassNamespace(messageType, proto)

  let serializer = []
  let deserializer = []
  let statics = []
  let constructorCode = []
  let oneOfs = []
  let memberCode = []

  messageType.enumTypeList.forEach(entry => {
    let valueCode = []
    entry.valueList.forEach(enumValue => {
      valueCode.push(`${enumValue.name}: ${enumValue.number}`)
    })
    statics.push(`
    /**
     * @enum
     */
    ${entry.name}: {
      ${valueCode.join(',\n      ')}
    }`)
  })
  messageType.oneofDeclList.forEach(prop => {
    let upperCase = prop.name.substring(0, 1).toUpperCase() + prop.name.substring(1)
    const index = oneOfs.length
    oneOfs.push(Object.assign({
      types: [],
      names: [],
      event: `change${upperCase}`
    }, prop))
    memberCode.push(`
    // oneOf property apply
    _applyOneOf${index}: function (value, old, name) {
      if (value !== null) {
        this.set${upperCase}(value);
      }
      
      // reset all other values
      this.__oneOfs[${index}].forEach(function (prop) {
        if (prop !== name) {
          this.reset(prop);
        }
      }, this)
    }
    `)
  })

  messageType.fieldList.forEach(prop => {
    let type = typeMap[prop.type]
    const list = prop.label === 3
    prop.comment = ''
    let upperCase = prop.name.substring(0, 1).toUpperCase() + prop.name.substring(1)
    if (!type && prop.typeName) {
      // reference to another proto message
      if (prop.type === 14) {
        // enum
        type = {
          qxType: 'Number',
          pbType: 'Enum',
          emptyComparison: ' !== 0.0',
          comment: ''
        }
        if (prop.defaultValue === undefined) {
          // according to protobuf spec enums default value is always 0
          prop.defaultValue = 0
        }
        if (prop.typeName) {
          prop.comment = `
    /**
     * Enum of type {@link ${baseNamespace}${prop.typeName}}
     */`
        }
      } else if (prop.type === 11) {
        // reference
        type = {
          qxType: `${baseNamespace}${prop.typeName}`,
          readerCode: list ? `
          case ${prop.number}:
            value = new ${baseNamespace}${prop.typeName};
            reader.readMessage(value, ${baseNamespace}${prop.typeName}.deserializeBinaryFromReader);
            msg.get${upperCase}().push(value);
            break;
          ` : `
          case ${prop.number}:
            value = new ${baseNamespace}${prop.typeName};
            reader.readMessage(value, ${baseNamespace}${prop.typeName}.deserializeBinaryFromReader);
            msg.set${upperCase}(value);
            break;
          `,
          writerCode: list ? `
      f = message.get${upperCase}();
      if (f != null) {
        writer.writeRepeatedMessage(
          ${prop.number},
          f,
          ${baseNamespace}${prop.typeName}.serializeBinaryToWriter
        );
      }
      ` : `
      f = message.get${upperCase}();
      if (f != null) {
        writer.writeMessage(
          ${prop.number},
          f,
          ${baseNamespace}${prop.typeName}.serializeBinaryToWriter
        );
      }
      `,
          emptyComparison: ' !== null'
        }
      }
    }
    if (!type) {
      console.error('undefined type:', prop)
      return
    }
    if (prop.defaultValue === undefined && type.hasOwnProperty('defaultValue')) {
      // according to protobuf spec enums default value is always 0
      prop.defaultValue = type.defaultValue
    }
    let additionalPropertyCode = []
    if (prop.hasOwnProperty('oneofIndex') && prop.oneofIndex !== undefined) {
      const oneOf = oneOfs[prop.oneofIndex]
      oneOf.types.push(prop.type)
      oneOf.names.push(prop.name)
      additionalPropertyCode.push(`,
      apply: '_applyOneOf${prop.oneofIndex}'`)
    }

    if (type.hasOwnProperty('transform')) {
      additionalPropertyCode.push(`,
      transform: '${type.transform}'`)
    }

    if (prop.options && prop.options.hasOwnProperty('annotations')) {
      additionalPropertyCode.push(`,
      "@": ['${prop.options.annotations.split(',').map(x => x.trim()).join('\', \'')}']`)
    }

    if (list) {
      properties.push(`
    /**
     * @type {qx.data.Array} array of {@link ${type.qxType}}
     */
    ${prop.name}: {
      check: 'qx.data.Array',
      deferredInit: true,
      event: 'change${upperCase}'
    }`)
      constructorCode.push(`this.init${upperCase}(new qx.data.Array());`)
    } else {
      properties.push(`${prop.comment}
    ${prop.name}: {
      check: '${type.qxType}',
      init: ${prop.defaultValue !== undefined ? prop.defaultValue : null},
      event: 'change${upperCase}'${additionalPropertyCode.join('')}
    }`)
    }

    if (type.writerCode) {
      serializer.push(type.writerCode)
    } else if (type.pbType) {
      if (list) {
        serializer.push(`
      f = message.get${upperCase}();
      if (f${type.emptyComparison}) {
         writer.writeRepeated${type.pbType}(
           ${prop.number},
           f
        );
      }
`)
      } else {
        serializer.push(`
      f = message.get${upperCase}();
      if (f${type.emptyComparison}) {
         writer.write${type.pbType}(
           ${prop.number},
           f
        );
      }
`)
      }
    }

    if (type.readerCode) {
      deserializer.push(type.readerCode)
    } else if (type.pbType) {
      if (list) {
        deserializer.push(`
          case ${prop.number}:
            value = reader.read${type.pbType}();
            msg.get${upperCase}().push(value);
            break;
`)
      } else {
        deserializer.push(`
          case ${prop.number}:
            value = reader.read${type.pbType}();
            msg.set${upperCase}(value);
            break;
`)
      }
    }
  })

  oneOfs.forEach((oneOf, index) => {
    // try to find a matching type superset
    let complexType = true
    oneOf.types.some(entry => {
      if (entry !== 11) {
        complexType = false
        return true
      }
    })
    const oneofTypeCheck = complexType ? `
      check: '${baseNamespace}.core.BaseMessage',` : ''
    properties.push(`
    
    /**
     * oneOfIndex: ${index}
     */
    ${oneOf.name}: {${oneofTypeCheck}
      init: ${oneOf.defaultValue !== undefined ? oneOf.defaultValue : null},
      event: '${oneOf.event}'
    }`)

    // write the one of members
    if (index === 0) {
      memberCode.unshift(`
    // array with oneOf property groups
    __oneOfs: null`)
      constructorCode.push('this.__oneOfs = [];')
    }
    constructorCode.push(` this.__oneOfs[${index}] = ['${oneOf.names.join('\', \'')}'];`)
  })

  if (deserializer.length) {
    deserializer = `      while (reader.nextField()) {
        if (reader.isEndGroup()) {
          break;
        }
        var value;
        var field = reader.getFieldNumber();
        switch (field) {
${deserializer.join('')}
          default:
            reader.skipField();
            break;
        }
      }
      return msg;
    `
  }

  // class basics
  let initCode = [`extend: ${config.getExtend('messageType', classNamespace)}`]
  const includes = config.getIncludes('messageType', classNamespace)
  if (includes.length) {
    initCode.push(`include: [${includes.join(', ')}]`)
  }
  const interfaces = config.getImplements('messageType', classNamespace)
  if (interfaces.length) {
    initCode.push(`implement: [${interfaces.join(', ')}]}`)
  }


  if (constructorCode.length > 0) {
    // add constructor
    constructorCode = `
  /*
  *****************************************************************************
     CONSTRUCTOR
  *****************************************************************************
  */
  construct: function (props) {
    ${constructorCode.join('\n   ')}
    this.base(arguments, props);
  },
  `
  }

  const code = `${getClassComment(messageType, s, proto, 4)}
qx.Class.define('${classNamespace}', {
  ${initCode.join(',\n  ')},
  ${constructorCode}
  
  /*
  *****************************************************************************
     STATICS
  *****************************************************************************
  */
  statics: {
    ${statics.join(',\n    ')}${statics.length > 0 ? ',' : ''}
    
    /**
     * Serializes the given message to binary data (in protobuf wire
     * format), writing to the given BinaryWriter.
     * @param message {proto.core.BaseMessage}
     * @param writer {jspb.BinaryWriter}
     * @suppress {unusedLocalVariables} f is only used for nested messages
     */
    serializeBinaryToWriter: function (message, writer) {
      var f = undefined;
${serializer.join('')}
    },
    
    /**
     * Deserializes binary data (in protobuf wire format).
     * @param bytes {jspb.ByteSource} The bytes to deserialize.
     * @return {${classNamespace}}
     */
    deserializeBinary: function (bytes) {
      var reader = new jspb.BinaryReader(bytes);
      var msg = new ${classNamespace}();
      return ${classNamespace}.deserializeBinaryFromReader(msg, reader);
    },
    
    /**
     * Deserializes binary data (in protobuf wire format) from the
     * given reader into the given message object.
     * @param msg {${classNamespace}} The message object to deserialize into.
     * @param reader {jspb.BinaryReader} The BinaryReader to use.
     * @return {${classNamespace}}
     */
    deserializeBinaryFromReader: function (msg, reader) {
${deserializer}      
    }
  },
  
  /*
  *****************************************************************************
     PROPERTIES
  *****************************************************************************
  */
  properties: {
${properties.join(',\n')}
  },
  
  /*
  *****************************************************************************
     MEMBERS
  *****************************************************************************
  */
  members: {
${memberCode.join(',\n')}    
  }
})
`
  return {
    namespace: classNamespace,
    code: code
  }
}

module.exports = genTypeClass