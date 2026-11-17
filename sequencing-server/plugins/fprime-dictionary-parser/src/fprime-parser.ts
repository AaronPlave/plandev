import type * as ampcs from '@nasa-jpl/plandev-ampcs';
import type { FormalParameter, FPPJSONDictionarySchema as FPPDictionary } from '../schema/fprime-types.js';
import type { ChannelDictionary, CommandDictionary, ParameterDictionary } from '@nasa-jpl/plandev-ampcs';

export default {
  name: 'fprime-parser',
  version: '1.0.0',
  author: 'AMMOS SeqDev',
  parseDictionary(dictionaryString: string): {
    commandDictionary?: CommandDictionary;
    channelDictionary?: ChannelDictionary;
    parameterDictionary?: ParameterDictionary;
  } {
    const dictionary = JSON.parse(dictionaryString) as FPPDictionary;

    const fswCommands = getCommands(dictionary);
    const fswCommandMap = createFswCommandMap(fswCommands);
    const enums = getEnums(dictionary);
    const enumMap = createEnumMap(enums);

    const header = {
      mission_name: dictionary.metadata?.deploymentName ?? '',
      schema_version: dictionary.metadata?.dictionarySpecVersion ?? '',
      spacecraft_ids: [],
      version: dictionary.metadata?.projectVersion ?? '',
    };
    const telemetries = getTelemetries(dictionary);
    const params = getParameters(dictionary, enumMap);

    return {
      channelDictionary: {
        header,
        id: '',
        path: null,
        telemetries,
        telemetryGroupMap: {},
        telemetryGroups: [],
        telemetryMap: Object.fromEntries(telemetries.map(t => [t.abbreviation, t])),
      },
      commandDictionary: {
        enumMap,
        enums,
        fswCommandMap,
        fswCommands,
        header,
        hwCommandMap: {},
        hwCommands: [],
        id: '',
        path: null,
      },
      parameterDictionary: {
        enumMap,
        enums,
        header,
        id: '',
        paramByTypeMap: {} as ampcs.ParameterDictionary['paramByTypeMap'],
        paramMap: Object.fromEntries(params.map(p => [p.param_name, p])),
        params,
        path: null,
      },
    };
  },
  processDictionary(_parsedDictionary: ampcs.CommandDictionary) {
    return '';
  },
};

function getEnums(dictionary: FPPDictionary): ampcs.Enum[] {
  return (
    dictionary.typeDefinitions
      ?.filter(typeDefinition => typeDefinition.kind === 'enum')
      .map(
        (type: any) =>
          ({
            name: type.qualifiedName,
            values: type.enumeratedConstants.map((enumConstant: any) => ({
              numeric: enumConstant.value,
              symbol: enumConstant.name,
            })),
          } as ampcs.Enum),
      ) ?? []
  );
}

/** F Prime channels, keyed by their fully qualified name (e.g. `CdhCore.cmdDisp.CommandsDispatched`). */
function getTelemetries(dictionary: FPPDictionary): ampcs.Telemetry[] {
  return (
    dictionary.telemetryChannels?.map(channel => ({
      abbreviation: channel.name,
      byte_length: (channel.type.size ?? 0) / 8,
      channel_derivation: 'None',
      description: channel.annotation ?? '',
      measurement_id: channel.id,
      name: channel.name,
      type: channel.type.name,
    })) ?? []
  );
}

/**
 * F Prime parameters with a scalar type, keyed by fully qualified name. Struct and array
 * parameters have no AMPCS equivalent and are skipped.
 */
function getParameters(dictionary: FPPDictionary, enumMap: ampcs.EnumMap): ampcs.Parameter[] {
  const params: ampcs.Parameter[] = [];
  for (const parameter of dictionary.parameters ?? []) {
    const type = resolveAlias(parameter.type, dictionary.typeDefinitions);
    const base = {
      bit_length: type.size ?? null,
      description: parameter.annotation ?? '',
      param_id: parameter.id,
      param_name: parameter.name,
      parameter_group: parameter.name.split('.').slice(0, -1).join('.'),
      parameter_version: null,
      rationale: '',
    };
    const number = { default_value: (parameter.default as number) ?? null, range: null, units: '' };
    if (type.kind === 'float') {
      params.push({ ...base, ...number, param_type: 'float_param' });
    } else if (type.kind === 'integer') {
      params.push({ ...base, ...number, param_type: type.signed ? 'integer_param' : 'unsigned_int_param' });
    } else if (type.kind === 'string') {
      const { bit_length: _bitLength, ...rest } = base;
      params.push({ ...rest, default_value: (parameter.default as string) ?? null, max_bit_length: (type.size ?? 0) * 8, param_type: 'string_param' });
    } else if (type.kind === 'qualifiedIdentifier' && enumMap[type.name]) {
      params.push({
        ...base,
        default_value: String(parameter.default ?? '').split('.').pop() ?? null,
        enum_type: enumMap[type.name],
        param_type: 'enum_param',
        range: null,
        units: '',
      });
    }
  }
  return params;
}

function resolveAlias(
  type: FormalParameter['type'],
  typeDefinitions: FPPDictionary['typeDefinitions'],
): FormalParameter['type'] {
  const definition = typeDefinitions?.find(t => t.qualifiedName === type.name);
  return definition?.kind === 'alias' ? resolveAlias(definition.underlyingType, typeDefinitions) : type;
}

function createEnumMap(enums: ampcs.Enum[]): ampcs.EnumMap {
  return enums.reduce((acc, enumDef) => {
    acc[enumDef.name] = enumDef;
    return acc;
  }, {} as ampcs.EnumMap);
}

function getCommands(dictionary: FPPDictionary): ampcs.FswCommand[] {
  return dictionary.commands?.map(command => commandToAMPCSCommand(command, dictionary.typeDefinitions)) ?? [];
}

function createFswCommandMap(ampcsCommands: ampcs.FswCommand[]): ampcs.FswCommandMap {
  return ampcsCommands.reduce((acc, command) => {
    acc[command.stem] = command;
    return acc;
  }, {} as ampcs.FswCommandMap);
}

function commandToAMPCSCommand(
  fppCommand: {
    name: string;
    commandKind: string;
    opcode: number;
    annotation?: string;
    formalParams: FormalParameter[];
    priority?: number;
    queueFullBehavior?: 'assert' | 'block' | 'drop';
    [k: string]: unknown;
  },
  typeDefinitions: FPPDictionary['typeDefinitions'],
): ampcs.FswCommand {
  return {
    ...argsToAMPCSArgs(fppCommand.formalParams, typeDefinitions),
    description: fppCommand.annotation ?? '',
    stem: fppCommand.name,
    type: 'fsw_command',
  };
}

function argsToAMPCSArgs(
  args: FormalParameter[],
  typeDefinitions: FPPDictionary['typeDefinitions'],
): {
  arguments: ampcs.FswCommandArgument[];
  argumentMap: ampcs.FswCommandArgumentMap;
} {
  const ampcsArguments = args.map(arg => {
    return argToFSWArg(arg, typeDefinitions);
  });
  return {
    argumentMap: ampcsArguments.reduce((acc, arg) => {
      acc[arg.name] = arg;
      return acc;
    }, {} as ampcs.FswCommandArgumentMap),
    arguments: ampcsArguments,
  };
}

function argToFSWArg(
  arg: FormalParameter,
  typeDefinitions: FPPDictionary['typeDefinitions'],
): ampcs.FswCommandArgument {
  switch (arg.type.kind) {
    case 'integer':
      if (arg.type.signed === undefined) {
        throw new Error(`Since argument is an integer there needs to be a 'signed' property`);
      }
      if (arg.type.signed) {
        return {
          arg_type: 'integer',
          bit_length: arg.type.size ?? null,
          default_value: 0,
          description: arg.annotation ?? '',
          name: arg.name,
          range: null,
          units: '',
        } as ampcs.FswCommandArgumentInteger;
      } else {
        return {
          arg_type: 'unsigned',
          bit_length: arg.type.size ?? null,
          default_value: 0,
          description: arg.annotation ?? '',
          name: arg.name,
          range: null,
          units: '',
        } as ampcs.FswCommandArgumentUnsigned;
      }
    case 'float':
      return {
        arg_type: 'float',
        bit_length: arg.type.size ?? null,
        default_value: 0,
        description: arg.annotation ?? '',
        name: arg.name,
        range: null,
        units: '',
      } as ampcs.FswCommandArgumentFloat;
    case 'bool':
      return {
        arg_type: 'boolean',
        description: arg.annotation ?? '',
        name: arg.name,
        bit_length: arg.type.size ?? null,
        default_value: 'true',
        format: null,
      } as ampcs.FswCommandArgumentBoolean;
    case 'string':
      return {
        arg_type: 'var_string',
        default_value: null,
        description: arg.annotation ?? '',
        // F Prime string `size` is the maximum length in bytes.
        max_bit_length: arg.type.size != null ? arg.type.size * 8 : null,
        name: arg.name,
        prefix_bit_length: null,
        valid_regex: null,
      } as ampcs.FswCommandArgumentVarString;
    case 'qualifiedIdentifier': {
      if (!typeDefinitions || !typeDefinitions.length) {
        throw new Error(`${arg.name} has no type defined in typeDefinitions`);
      }
      const typeDefinition = typeDefinitions.find(typeDefinition => typeDefinition.qualifiedName === arg.type.name) as
        | NonNullable<FPPDictionary['typeDefinitions']>[number]
        | undefined;
      if (!typeDefinition) {
        throw new Error(`${arg.name} has no type defined in typeDefinitions`);
      }
      switch (typeDefinition.kind) {
        case 'alias':
          // Recursively resolve the alias to its underlying type
          return argToFSWArg(
            {
              name: arg.name,
              type: typeDefinition.underlyingType,
              ref: arg.ref,
              annotation: arg.annotation,
            } as FormalParameter,
            typeDefinitions,
          );
        case 'enum':
          return {
            arg_type: 'enum',
            bit_length: arg.type.size ?? null,
            default_value: typeDefinition.default.split('.').pop() ?? null,
            description: arg.annotation ?? '',
            enum_name: typeDefinition.qualifiedName,
            name: arg.name,
            range: null,
          } as ampcs.FswCommandArgumentEnum;
        case 'array':
          return {
            arg_type: 'repeat',
            description: arg.annotation ?? typeDefinition.annotation ?? '',
            name: arg.name,
            // F Prime arrays are fixed-size and serialized without a length prefix.
            prefix_bit_length: null,
            repeat: {
              argumentMap: {},
              arguments: [
                argToFSWArg(
                  {
                    name: typeDefinition.elementType.name,
                    type: typeDefinition.elementType,
                    ref: false,
                    annotation: '',
                  } as FormalParameter,
                  typeDefinitions,
                ),
              ],
              min: typeDefinition.size,
              max: typeDefinition.size,
            },
          } as ampcs.FswCommandArgumentRepeat;
        case 'struct':
          return {
            arg_type: 'repeat',
            description: arg.annotation ?? typeDefinition.annotation ?? '',
            name: arg.name,
            prefix_bit_length: null,
            repeat: {
              argumentMap: {},
              arguments: Object.keys(typeDefinition.members).map(memberName => {
                const member = typeDefinition.members[memberName];
                if (!member) {
                  throw new Error(`Member ${memberName} not found in struct definition`);
                }
                return argToFSWArg(
                  {
                    name: memberName,
                    type: member.type,
                    ref: false,
                    annotation: member.annotation,
                  } as FormalParameter,
                  typeDefinitions,
                );
              }),
              min: 1,
              max: 1,
            },
          } as ampcs.FswCommandArgumentRepeat;
        default:
          throw new Error(`${arg.name} has no 'kind' defined by typeDefinitions`);
      }
    }
  }
}
