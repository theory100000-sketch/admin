require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("crear-club")
    .setDescription("Crea un club de la liga")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("nombre")
        .setDescription("Nombre del club")
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("presidente")
        .setDescription("Presidente del club")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("color_hex")
        .setDescription("Color del rol del club en HEX. Ejemplo: #ff0000")
        .setRequired(true)
    )
    .addAttachmentOption(option =>
      option
        .setName("escudo")
        .setDescription("Escudo del club")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("emoji")
        .setDescription("Emoji del club. Ejemplo: ⚡, 🦁, 🔥")
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("vicepresidente_1")
        .setDescription("Primer vicepresidente")
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName("vicepresidente_2")
        .setDescription("Segundo vicepresidente")
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName("vicepresidente_3")
        .setDescription("Tercer vicepresidente")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("borrar-club")
    .setDescription("Borra un club de la liga")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club que quieres borrar")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("editar-club")
    .setDescription("Edita el nombre, color o escudo de un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Club que quieres editar")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName("nuevo_nombre")
        .setDescription("Nuevo nombre del club")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("color_hex")
        .setDescription("Nuevo color HEX del rol. Ejemplo: #00ff00")
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option
        .setName("escudo")
        .setDescription("Nuevo escudo del club")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("cambiar-presidente")
    .setDescription("Cambia el presidente de un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Nuevo presidente")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("añadir-vicepresidente")
    .setDescription("Añade un vicepresidente a un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuario que será vicepresidente")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("quitar-vicepresidente")
    .setDescription("Quita un vicepresidente de un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Vicepresidente que quieres quitar")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ficha-club")
    .setDescription("Muestra la ficha de un club")
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("plantilla")
    .setDescription("Muestra la plantilla de un club")
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("lista-clubes")
    .setDescription("Muestra todos los clubes registrados"),

  new SlashCommandBuilder()
    .setName("logs-clubes")
    .setDescription("Configura el canal de logs de clubes")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Canal donde se enviarán los logs")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("economia-club")
    .setDescription("Muestra la economía de un club")
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("asignar-presupuesto")
    .setDescription("Asigna el presupuesto actual de un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option
        .setName("cantidad")
        .setDescription("Cantidad de dinero")
        .setRequired(true)
        .setMinValue(0)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo del cambio")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("añadir-dinero")
    .setDescription("Añade dinero a un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option
        .setName("cantidad")
        .setDescription("Cantidad a añadir")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo del ingreso")
        .setRequired(true)
    ),

      new SlashCommandBuilder()
    .setName("sancionar-club")
    .setDescription("Sanciona económicamente a un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Club que será sancionado")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo de la sanción")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("cantidad")
        .setDescription("Cantidad de la sanción")
        .setRequired(true)
        .setMinValue(1)
    ),

      new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Sanciona o advierte a un usuario")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuario sancionado")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo de la sanción")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("historial-sanciones")
    .setDescription("Muestra el historial de sanciones de un usuario")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Usuario del que quieres ver el historial")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("quitar-dinero")
    .setDescription("Quita dinero a un club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option
        .setName("cantidad")
        .setDescription("Cantidad a quitar")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo del gasto o sanción")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("historial-economia")
    .setDescription("Muestra el historial económico de un club")
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    ),

      new SlashCommandBuilder()
    .setName("bienvenidas")
    .setDescription("Configura el canal de bienvenidas")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Canal donde se enviarán las bienvenidas")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

      new SlashCommandBuilder()
    .setName("panel-tickets")
    .setDescription("Envía el panel de tickets en este canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("probar-bienvenida")
    .setDescription("Prueba el mensaje de bienvenida contigo")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("ranking-economia")
    .setDescription("Muestra el ranking económico de los clubes"),

  new SlashCommandBuilder()
    .setName("fichar")
    .setDescription("Realiza o envía una oferta de fichaje")
    .addUserOption(option =>
      option
        .setName("jugador")
        .setDescription("Jugador que quieres fichar")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("club_procedente")
        .setDescription("Club procedente del jugador o Agente Libre")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName("club_destino")
        .setDescription("Club que ficha al jugador")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option
        .setName("precio")
        .setDescription("Precio del fichaje")
        .setRequired(true)
        .setMinValue(0)
    )
    .addStringOption(option =>
      option
        .setName("id_ea_psn")
        .setDescription("ID de EA o PSN del jugador para mostrarlo en la web")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ofertas-fichajes")
    .setDescription("Muestra las ofertas de fichajes pendientes")
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Club del que quieres ver las ofertas")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("añadir-jugador")
    .setDescription("Añade un jugador a un club")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Jugador que quieres añadir")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("club")
        .setDescription("Nombre del club")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName("id_ea_psn")
        .setDescription("ID de EA o PSN del jugador para mostrarlo en la web")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("quitar-jugador")
    .setDescription("Quita un jugador de su club")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Jugador que quieres quitar")
        .setRequired(true)
    )
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log("Registrando comandos de clubes...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("✅ Comandos registrados correctamente.");
  } catch (error) {
    console.error(error);
  }
})();